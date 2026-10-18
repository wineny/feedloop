import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── I-34 ③ — 익명 게이트의 «DB 쪽» 유도가 맞는가 ─────────────────
//
// 순수 함수(pickGroupForAutoPr)는 auto-pr.test.ts 가 잰다. 여기서 재는 건 그 앞 단계다:
// 인사이트 → 메시지 → 대화 를 거슬러 「서로 다른 대화 몇 개인가 · 연락처가 있는가」를
// 실제로 뽑아내는가. 이게 틀리면 게이트는 통과하지만 «틀린 값으로» 통과한다 —
// hasContact 가 늘 true 로 나오는 버그는 게이트가 없는 것과 같다.

const state = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  errors: {} as Record<string, string>,
  rpc: vi.fn(),
  claim: vi.fn(),
  load: vi.fn(),
  execute: vi.fn(),
  grouping: vi.fn(),
  recovery: vi.fn(),
}));

vi.mock('@/lib/auto-dev/execute-run', () => ({
  claimRun: state.claim,
  loadRun: state.load,
  executeClaimedRun: state.execute,
}));
vi.mock('@/lib/groups/grouping', () => ({ runGrouping: state.grouping }));
vi.mock('@/lib/classify/recovery', () => ({ runClassificationRecovery: state.recovery }));

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    rpc: state.rpc,
    from(table: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {};
      for (const op of ['select', 'eq', 'in', 'is', 'not', 'order', 'limit']) {
        chain[op] = () => chain;
      }
      // 미발행 run 조회(`maybeSingle`)만 단건이다. 여기서는 없다고 답한다.
      let range: [number, number] | null = null;
      chain.range = (start: number, end: number) => { range = [start, end]; return chain; };
      chain.maybeSingle = async () => ({ data: null, error: null });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chain.then = (resolve: any, reject: any) => {
        const error = state.errors[table] ? { message: state.errors[table] } : null;
        return Promise.resolve({ data: range ? (state.rows[table] ?? []).slice(range[0], range[1] + 1) : state.rows[table] ?? [], error }).then(resolve, reject);
      };
      return chain;
    },
  }),
}));

import { runAutoPrForBot, loadAutoPrCandidates } from '@/lib/auto-dev/auto-pr';

const GROUP = { id: 'g1', status: 'open', category: 'bug', follow_up_pending: false };

function setup(over: Partial<typeof state.rows> = {}) {
  state.rows = {
    insight_groups: [GROUP],
    insights: [
      { group_id: 'g1', message_id: 'm1' },
      { group_id: 'g1', message_id: 'm2' },
    ],
    auto_dev_runs: [],
    messages: [
      { id: 'm1', conversation_id: 'c1' },
      { id: 'm2', conversation_id: 'c1' },
    ],
    conversations: [{ id: 'c1', source: 'web', contact_email: null, contact_phone: null }],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.errors = {};
  setup();
  state.recovery.mockResolvedValue({ classified: 0, noInsight: 0, failed: 0, exhausted: 0, pending: 0, deferred: false });
  state.grouping.mockResolvedValue({ grouped: 0, failures: [], deferred: false });
  state.rpc.mockResolvedValue({ data: 'run-1', error: null });
  state.claim.mockResolvedValue('token');
  state.load.mockResolvedValue({ id: 'run-1' });
  state.execute.mockResolvedValue({ pr_url: 'https://github.com/qa/repo/pull/9' });
});

describe('runAutoPrForBot — 익명 게이트', () => {
  it('연락처 없는 1인 묶음이면 run 을 «만들지도» 않는다', async () => {
    // 인사이트는 둘이지만 둘 다 같은 대화(c1)에서 나왔다 — 한 사람이 두 번 말한 것이다.
    const result = await runAutoPrForBot('bot-1');

    expect(result.skippedReason).toBe('anonymous_only');
    expect(result.groupId).toBeNull();
    expect(result.prUrl).toBeNull();
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.execute).not.toHaveBeenCalled();
  });

  it('서로 다른 대화 2개면 PR 로 간다', async () => {
    setup({
      messages: [
        { id: 'm1', conversation_id: 'c1' },
        { id: 'm2', conversation_id: 'c2' },
      ],
      conversations: [
        { id: 'c1', source: 'web', contact_email: null, contact_phone: null },
        { id: 'c2', source: 'web', contact_email: null, contact_phone: null },
      ],
    });

    const result = await runAutoPrForBot('bot-1');

    expect(result.skippedReason).toBeUndefined();
    expect(result.groupId).toBe('g1');
    expect(result.prUrl).toBe('https://github.com/qa/repo/pull/9');
  });

  it('1인이어도 연락처(이메일)가 있으면 PR 로 간다', async () => {
    setup({ conversations: [{ id: 'c1', source: 'web', contact_email: 'a@b.com', contact_phone: null }] });

    expect((await runAutoPrForBot('bot-1')).prUrl).toBe('https://github.com/qa/repo/pull/9');
  });

  it('1인이어도 연락처(전화)가 있으면 PR 로 간다', async () => {
    setup({ conversations: [{ id: 'c1', source: 'web', contact_email: null, contact_phone: '010-0000-0000' }] });

    expect((await runAutoPrForBot('bot-1')).prUrl).toBe('https://github.com/qa/repo/pull/9');
  });

  it('메시지에 대화가 안 붙어 있으면 인원을 셀 수 없으니 막는다', async () => {
    // 옛 텔레그램 경로처럼 conversation_id 가 NULL 인 메시지. 0명이지 2명이 아니다.
    setup({ messages: [{ id: 'm1', conversation_id: null }, { id: 'm2', conversation_id: null }] });

    expect((await runAutoPrForBot('bot-1')).skippedReason).toBe('anonymous_only');
  });

  it('채널톡 대화는 연락처 칸이 비어 있어도 1인 묶음이 대상이다', async () => {
    // 인증된 입구는 플랫폼 계정으로 사람을 알고 그 계정으로 답장이 간다.
    // `conversations` 의 연락처 칸은 비어 있는 게 정상이라, 컬럼만 보면 그 입구의 대화가
    // 전부 익명으로 걸려 자동 모드가 거기서는 영영 안 돈다.
    setup({ conversations: [{ id: 'c1', source: 'channel', contact_email: null, contact_phone: null }] });

    expect((await runAutoPrForBot('bot-1')).prUrl).toBe('https://github.com/qa/repo/pull/9');
  });

  it('텔레그램 대화도 같다', async () => {
    setup({ conversations: [{ id: 'c1', source: 'telegram', contact_email: null, contact_phone: null }] });

    expect((await runAutoPrForBot('bot-1')).prUrl).toBe('https://github.com/qa/repo/pull/9');
  });

  it('카카오 1인 묶음은 막는다 — 웹훅에 서명도 경로 시크릿도 없다(I-34 ②)', async () => {
    // 식별 규칙이 허용 목록인 이유. 차단 목록(「web 이 아니면 식별됨」)으로 두면 비웹 입구
    // 중 «가장 약한 인증»이 이 게이트의 강도를 정한다 — 카카오 웹훅을 누가 다시 켜는 순간
    // 무인증 POST 한 번이 만든 대화가 「식별됨」으로 세어져 사람 없이 PR 이 열린다.
    setup({ conversations: [{ id: 'c1', source: 'kakao', contact_email: null, contact_phone: null }] });

    const result = await runAutoPrForBot('bot-1');

    expect(result.skippedReason).toBe('anonymous_only');
    expect(result.prUrl).toBeNull();
  });

  it('카카오라도 연락처를 남겼으면 대상이다 — 입구가 아니라 연락처로 통과한다', async () => {
    setup({ conversations: [{ id: 'c1', source: 'kakao', contact_email: 'a@b.com', contact_phone: null }] });

    expect((await runAutoPrForBot('bot-1')).prUrl).toBe('https://github.com/qa/repo/pull/9');
  });

  it('카카오도 서로 다른 대화 2개면 대상이다 — 인원 규칙은 그대로 산다', async () => {
    setup({
      messages: [
        { id: 'm1', conversation_id: 'c1' },
        { id: 'm2', conversation_id: 'c2' },
      ],
      conversations: [
        { id: 'c1', source: 'kakao', contact_email: null, contact_phone: null },
        { id: 'c2', source: 'kakao', contact_email: null, contact_phone: null },
      ],
    });

    expect((await runAutoPrForBot('bot-1')).prUrl).toBe('https://github.com/qa/repo/pull/9');
  });

  it('연락처 조회가 실패하면 PR 을 만들지 않고 오류로 끝낸다 — fail closed', async () => {
    state.errors.conversations = 'boom';

    const result = await runAutoPrForBot('bot-1');

    expect(result.error).toBe('boom');
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

 it('우선순위 인원은 동일 채널 사람을 접고, 익명 게이트 대화 수는 보존한다', async () => {
    setup({
      messages: [{ id: 'm1', conversation_id: 'c1' }, { id: 'm2', conversation_id: 'c2' }],
      conversations: [{ id: 'c1', source: 'channel', channel_person_id: 'person' }, { id: 'c2', source: 'channel', channel_person_id: 'person' }],
    });
    expect((await loadAutoPrCandidates('bot-1'))[0]).toMatchObject({ personCount: 1, distinctConversations: 2 });
    setup({
      messages: [{ id: 'm1', conversation_id: 'c1' }, { id: 'm2', conversation_id: 'c2' }],
      conversations: [{ id: 'c1', source: 'web' }, { id: 'c2', source: 'web' }],
    });
    expect((await loadAutoPrCandidates('bot-1'))[0]).toMatchObject({ personCount: 2, distinctConversations: 2 });
  });

it('51번째 오래된 묶음도 전체 후보 점수로 고른다', async () => {
  setup({
    insight_groups: Array.from({ length: 51 }, (_, i) => ({ ...GROUP, id: `g${i}`, impact_core: i === 50 })),
    insights: Array.from({ length: 51 }, (_, i) => ({ group_id: `g${i}`, message_id: 'm1' })),
    messages: [{ id: 'm1', conversation_id: 'c1' }],
    conversations: [{ id: 'c1', source: 'web', contact_email: 'qa@example.com' }],
  });
  expect(await loadAutoPrCandidates('bot-1')).toHaveLength(51);
  expect((await runAutoPrForBot('bot-1')).groupId).toBe('g50');
});
