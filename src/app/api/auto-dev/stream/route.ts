import { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { claimRun, executeClaimedRun, loadRun, one, type LoadedRun } from '@/lib/auto-dev/execute-run';

// Anthropic 스트리밍 생성 + Octokit 6~8회 왕복이 들어간다.
// 기본값에 의존하지 않고 의도를 코드에 박는다.
export const maxDuration = 300;

type TerminalStatus = 'failed' | 'stopped' | 'unverifiable';

type AutoDevEvent =
  | { type: 'log'; message: string }
  | { type: 'complete'; pr_url: string; pr_number: number; files_changed: object[] }
  | { type: 'error'; step: string; message: string; recoverable: boolean; status?: TerminalStatus; reason?: string };

/** Keep the existing error event envelope so clients still close the stream. */
function terminalEvent(run: LoadedRun): AutoDevEvent | null {
  if (!['failed','stopped','unverifiable'].includes(run.status)) return null;
  const status = run.status as TerminalStatus;
  const fallback = {
    failed: '이전 실행이 실패했습니다',
    stopped: '이 실행은 중단되었습니다',
    unverifiable: '이 실행은 검증할 수 없습니다',
  }[status];
  const reason = status === 'failed'
    ? run.error_message ?? run.stop_reason ?? fallback
    : run.stop_reason ?? run.error_message ?? fallback;
  return {type:'error',step:'pipeline',status,reason,message:reason,recoverable:false};
}

/** 이벤트 목록을 SSE 로 흘려보내고 즉시 닫는다 (재생 전용). */
function replay(events: AutoDevEvent[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const e of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

export async function GET(req: NextRequest) {
  const deadline=Date.now()+240_000;
  const runId = req.nextUrl.searchParams.get('runId');
  if (!runId) {
    return new Response('runId is required', { status: 400 });
  }

  // 1. 인증 — 실행이 일어나는 곳에 게이트를 단다.
  //    same-origin EventSource 는 쿠키를 기본 전송하므로 클라이언트 수정이 필요 없다.
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 });
  }

  const run = await loadRun(runId);
  if (!run) {
    return new Response('Run not found', { status: 404 });
  }

  // 2. 소유권 — 남의 run 을 우리 GITHUB_TOKEN 으로 실행시킬 수 없게 한다.
  const bot = one<{ github_repo_url: string | null; user_id: string }>(run.bots);
  if (!bot || bot.user_id !== session.user.id) {
    return new Response('Forbidden', { status: 403 });
  }

  // 3. 이미 끝난 run 은 재실행하지 않고 저장된 결과만 재생한다.
  if (run.status === 'completed') {
    return replay([
      { type: 'log', message: '이미 완료된 실행입니다. 저장된 결과를 표시합니다.' },
      {
        type: 'complete',
        pr_url: run.pr_url ?? '',
        pr_number: run.pr_number ?? 0,
        files_changed: run.files_changed ?? [],
      },
    ]);
  }

  const terminal = terminalEvent(run);
  if (terminal && run.publication_status !== 'pending') return replay([terminal]);

  // 4. 실행권 획득 — 동시/중복 요청 중 하나만 통과한다 (execute-run.ts 참고).
  const leaseToken = await claimRun(runId);
  if (!leaseToken) {
    return replay([
      {
        type: 'error',
        step: 'already_running',
        message: '이 실행은 이미 진행 중입니다. 중복 PR 을 막기 위해 다시 실행하지 않았습니다.',
        recoverable: true,
      },
    ]);
  }

  // The pre-claim snapshot may predate the previous worker's final budget/intent writes.
  const claimedRun = await loadRun(runId);
  if (!claimedRun) return new Response('Run reload failed', {status:503});

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: AutoDevEvent) => {
        if (closed) return;
        try {controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));} catch {closed=true;}
      };
      // 클라이언트가 close() 할 근거(complete|error)를 못 받으면 재연결을 시도한다.
      // 어떤 경로로 끝나든 종료 이벤트를 반드시 하나 보낸 뒤에 닫는다.
      const finish = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };

      try {
        send({ type: 'log', message: '자동 수정 시작...' });

        // 실행·결과 저장은 크론과 같은 경로를 탄다. 여기서는 진행 로그만 흘려보낸다.
        const result = await executeClaimedRun(claimedRun, leaseToken, (message) => send({ type: 'log', message }),deadline);

        send({
          type: 'complete',
          pr_url: result.pr_url,
          pr_number: result.pr_number,
          files_changed: result.files_changed,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        const step = message.includes('수정 대상 또는 저장소 URL') ? 'validation' : 'pipeline';
        // executeClaimedRun persists the outcome before throwing; report that exact state.
        const persisted = await loadRun(runId).catch(() => null);
        send((persisted && terminalEvent(persisted)) || { type: 'error', step, message, recoverable: false });
      } finally {
        finish();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
