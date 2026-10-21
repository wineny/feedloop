import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 테이블별 응답을 갈아끼우는 Supabase 모킹.
const tables: Record<string, unknown[]> = {};
let queryError: { message: string } | null = null;
const inserted: { table: string; rows: unknown[] }[] = [];
const updated: { table: string; patch: Record<string, unknown> }[] = [];

// PR 머지·닫힘 여부는 Octokit 이 답한다.
let prMerged = false;
let prFailure = false;
let deployments:Record<string,unknown>[]=[];
let deploymentStatuses:Record<string,unknown>[]=[];
let prState: 'open' | 'closed' = 'open';
let prDraft = false;
let prBody: string | null = null;
const { reviewAndPromoteDraft } = vi.hoisted(() => ({ reviewAndPromoteDraft: vi.fn() }));
vi.mock('@/lib/auto-dev/draft-promotion', () => ({ reviewAndPromoteDraft }));
let octokitOptions: unknown[] = [];
let prGetCalls = 0;
/** getPrState 1회가 「걸리는」 시간. 가짜 시계를 진행시켜 run 루프 마감을 시험한다. */
let prGetCostMs = 0;

vi.mock('@octokit/rest', () => ({
  Octokit: function (opts: unknown) {
    octokitOptions.push(opts);
    return {
      pulls: {
        get: async () => {
          prGetCalls += 1;
          clock += prGetCostMs;
          if (prFailure) throw new Error('github unavailable');
          return { data: { merged: prMerged, state: prState, draft: prDraft, body: prBody } };
        },
      },
      repos: {
        listDeployments: async () => ({ data: deployments }),
        listDeploymentStatuses: async () => ({ data: deploymentStatuses }),
      },
    };

  },
}));

// 채널톡 전송. 되돌림이 실제로 나가는지·언제 잘리는지를 여기서 본다.
let sendCostMs = 0;
const sendBotMessageMock = vi.fn(async () => {
  clock += sendCostMs;
  return { ok: true } as { ok: boolean; status?: number; message?: string };
});

vi.mock('@/lib/channel/client', () => ({
  sendBotMessage: sendBotMessageMock,
}));

/** 결정적 가짜 시계. 예산 산술을 실시간을 기다리지 않고 그대로 시험한다. */
let clock = 0;

let insertSeq = 0;

function chain(table: string) {
  const c: Record<string, unknown> = {};
  const filters: [string, unknown][] = [];
  for (const m of ['in', 'is', 'not', 'lt', 'gt', 'gte', 'order', 'limit']) {
    c[m] = vi.fn(() => c);
  }

  // `neq` 도 **진짜로 적용한다.** 메일 회수 질의가 `email_delivery_status <> 'skipped'` 로
  // 좁히는데 흉내만 내면, 「메일 안 붙임」으로 만든 행에 크론이 메일을 보내도 초록이 된다.
  const excluded: [string, unknown][] = [];
  c.neq = vi.fn((col: string, value: unknown) => {
    excluded.push([col, value]);
    return c;
  });

  // ⚠️ `eq` 는 **진짜로 적용한다.** upsert 가 만든 행을 `tables` 에 쌓게 된 뒤로, 흉내만
  // 내면 run A 가 만든 되돌림이 run B 의 「이미 보냈나」 조회에 걸려 전송이 통째로 멎는다.
  // 값을 안 가진 픽스처 행은 그대로 통과시킨다 — 「이미 받았다」를 최소한으로 적어둔
  // 기존 테스트들이 계속 자기 뜻대로 읽히게.
  c.eq = vi.fn((col: string, value: unknown) => {
    filters.push([col, value]);
    return c;
  });

  const rows = () =>
    (tables[table] ?? []).filter((row) => {
      const r = row as Record<string, unknown>;
      return (
        filters.every(([col, value]) => !(col in r) || r[col] === value) &&
        excluded.every(([col, value]) => !(col in r) || r[col] !== value)
      );
    });

  c.maybeSingle = vi.fn(async () => ({ data: rows()[0] ?? null, error: null }));
  c.single = vi.fn(async () => ({ data: rows()[0] ?? null, error: queryError }));
  c.then = (resolve: (v: unknown) => void) => resolve({ data: rows(), error: queryError });
  return c;
}

// 이메일은 별도 모듈이 맡는다 — 여기서는 «누구에게 보내려 했는지» 만 잡는다.
const emailed: Record<string, unknown>[] = [];
vi.mock('@/lib/email/notify', () => ({
  emailResponse: vi.fn(async (input: Record<string, unknown>) => {
    emailed.push(input);
    return input.conversationId === 'c-web'
      ? { sent: true, to: 'visitor@example.com' }
      : { sent: false, reason: 'no_email' };
  }),
}));

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: vi.fn((table: string) => ({
      select: vi.fn(() => chain(table)),
      // `.upsert(rows).select('id, conversation_id')` — 만든 행에 id 를 붙여 돌려준다.
      // 돌려줄 때는 PostgREST 처럼 **고른 컬럼만** 준다(전체 행을 주면 호출부가 실제로는
      // 없는 컬럼을 읽어도 테스트가 통과한다). 대신 `tables` 에는 **전체 행을 쌓는다** —
      // 저장 뒤 메일 대상을 고르려고 이 run 의 되돌림을 다시 읽기 때문이다.
      upsert: vi.fn((rows: unknown) => {
        const list = Array.isArray(rows) ? rows : [rows];
        inserted.push({ table, rows: list });
        const created = list.map((r) => {
          insertSeq += 1;
          return { ...(r as Record<string, unknown>), id: `${table}-${insertSeq}` };
        });
        tables[table] = [...(tables[table] ?? []), ...created];
        const withIds = created.map((r) => ({
          id: r.id,
          conversation_id: (r as { conversation_id?: string }).conversation_id,
        }));
        return {
          select: vi.fn(async () => ({ data: withIds, error: null })),
          then: (resolve: (v: unknown) => void) => resolve({ error: null }),
        };
      }),
      update: vi.fn((patch: Record<string, unknown>) => {
        updated.push({ table, patch });
        return chain(table);
      }),
    })),
  }),
}));

type Mod = typeof import('@/lib/auto-dev/loop-closed');
let mod: Mod;

beforeEach(async () => {
  vi.clearAllMocks();
  queryError = null;
  for (const k of Object.keys(tables)) delete tables[k];
  inserted.length = 0;
  updated.length = 0;
  emailed.length = 0;
  prMerged = false; prFailure = false;
  deployments=[];deploymentStatuses=[];delete process.env.FEEDLOOP_DEPLOYMENT_ENVIRONMENT;
  prState = 'open';
  prDraft = false;
  prBody = null;
  reviewAndPromoteDraft.mockResolvedValue({ draft: false, draftGate: 'promoted' });
  octokitOptions = [];
  prGetCalls = 0;
  prGetCostMs = 0;
  sendCostMs = 0;
  insertSeq = 0;
  clock = 0;
  sendBotMessageMock.mockClear();
  sendBotMessageMock.mockImplementation(async () => {
    clock += sendCostMs;
    return { ok: true };
  });
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  process.env.GITHUB_TOKEN = 'ghp_test';
  vi.resetModules();
  mod = await import('@/lib/auto-dev/loop-closed');
});

afterEach(() => {
  vi.restoreAllMocks();
});

const RUN = {
  id: 'run-1',
  bot_id: 'bot-1',
  group_id: 'g1',
  insight_id: null,
  pr_url: 'https://github.com/o/r/pull/12',
  pr_number: 12,
  merged_at: null,
  title: '쿠폰 적용 버튼이 눌리지 않음',
};

const responseUpdates = () => updated.filter((u) => u.table === 'responses');
const insertedResponses = () =>
  (inserted.find((i) => i.table === 'responses')?.rows ?? []) as Record<string, unknown>[];

describe('buildLoopClosedBody', () => {
  it('무엇이 반영됐는지와 PR 번호를 담는다', () => {
    expect(mod.buildLoopClosedBody('쿠폰 버그', 12)).toBe(
      '"쿠폰 버그" 말씀해주신 문제를 고쳤어요. 서비스에 반영되기까지 조금 걸릴 수 있어요. (수정 #12)',
    );
  });

  it('PR 번호가 없으면 번호 없이 말한다', () => {
    expect(mod.buildLoopClosedBody('쿠폰 버그', null)).not.toContain('#');
  });

  it('PR URL 이 있으면 본문 끝에 그대로 싣는다 — 위젯이 이걸로 「바뀐 내용 보기」 링크를 만든다', () => {
    expect(mod.buildLoopClosedBody('쿠폰 버그', 12, 'https://github.com/o/r/pull/12')).toBe(
      '"쿠폰 버그" 말씀해주신 문제를 고쳤어요. 서비스에 반영되기까지 조금 걸릴 수 있어요. (수정 #12) https://github.com/o/r/pull/12',
    );
  });
});

describe('closeLoopForRun — 기존 채널 무회귀', () => {
  it('머지가 안 됐으면 아무것도 만들지 않는다', async () => {
    prMerged = false; prFailure = false;
  deployments=[];deploymentStatuses=[];delete process.env.FEEDLOOP_DEPLOYMENT_ENVIRONMENT;
    const res = await mod.closeLoopForRun(RUN);

    expect(res.merged).toBe(false);
    expect(res.closed).toBe(false);
    expect(res.delivered).toBe(0);
    expect(res.deferred).toBe(0);
    expect(inserted).toHaveLength(0);
    expect(updated).toHaveLength(1);
    expect(updated[0].patch).toHaveProperty('follow_up_checked_at');
  });

  it('머지 없이 닫힌 PR 은 closed_at 을 찍고 묶음을 다시 열되, 되돌림은 보내지 않는다', async () => {
    prMerged = false; prFailure = false;
  deployments=[];deploymentStatuses=[];delete process.env.FEEDLOOP_DEPLOYMENT_ENVIRONMENT;
    prState = 'closed';
    tables.insights = [{ id: 'i1', messages: { conversation_id: 'c-web' } }];
    tables.conversations = [{ id: 'c-web', source: 'web' }];

    const res = await mod.closeLoopForRun(RUN);

    expect(res.closed).toBe(true);
    expect(res.merged).toBe(false);
    expect(inserted).toHaveLength(0);
    expect(updated.find((u) => u.table === 'auto_dev_runs' && u.patch.closed_at)?.patch).toHaveProperty('closed_at');
    expect(updated.find((u) => u.table === 'insight_groups')?.patch).toEqual({ status: 'open' });
  });

  it('웹·카카오만 있으면 채널톡 전송을 부르지 않는다 — 다른 채널의 동작이 안 바뀐다', async () => {
    prMerged = true;
    tables.insights = [
      { id: 'i1', messages: { conversation_id: 'c-web' } },
      { id: 'i2', messages: { conversation_id: 'c-kakao' } },
    ];
    tables.responses = [];
    tables.conversations = [
      { id: 'c-web', source: 'web', external_user_id: 'v1' },
      { id: 'c-kakao', source: 'kakao', external_user_id: 'k1' },
    ];

    const res = await mod.closeLoopForRun(RUN);

    expect(res.delivered).toBe(2);
    expect(res.deferred).toBe(0);
    expect(sendBotMessageMock).not.toHaveBeenCalled();

    const rows = insertedResponses();
    const web = rows.find((r) => r.conversation_id === 'c-web')!;
    // 웹은 위젯이 폴링으로 바로 가져간다. 카카오는 선톡이 안 되니 대기열에 남는다.
    expect(web.delivered_at).toBeTruthy();
    expect(rows.find((r) => r.conversation_id === 'c-kakao')!.delivered_at).toBeNull();
    expect(web.response_type).toBe('loop_closed');
    expect(web.auto_dev_run_id).toBe('run-1');

    // 되돌림마다 이메일 경로를 한 번씩 태운다 — 채널과 무관하게(카카오도 이메일이 있으면 간다).
    // 보낼지 말지는 notify 가 연락처를 보고 정하고, 여기서는 «시도한 수»와 «성공 수»만 본다.
    expect(emailed).toHaveLength(2);
    expect(emailed[0]).toMatchObject({
      kind: 'loop_closed',
      responseId: 'responses-1',
      botId: 'bot-1',
      title: RUN.title,
      prNumber: 12,
      prUrl: RUN.pr_url,
    });
    expect(res.emailed).toBe(1);
  });

  it('한 묶음의 대화가 각자 저장된 언어(conversations.locale)로 받는다 — 모르면(NULL) 제목의 한글 여부로 추정', async () => {
    prMerged = true;
    tables.insights = [
      { id: 'i1', messages: { conversation_id: 'c-en' } },
      { id: 'i2', messages: { conversation_id: 'c-ko' } },
      { id: 'i3', messages: { conversation_id: 'c-null' } },
    ];
    tables.responses = [];
    tables.conversations = [
      { id: 'c-en', source: 'web', external_user_id: 'v1', locale: 'en' },
      { id: 'c-ko', source: 'web', external_user_id: 'v2', locale: 'ko' },
      { id: 'c-null', source: 'kakao', external_user_id: 'k1', locale: null },
    ];

    await mod.closeLoopForRun({ ...RUN, title: '쿠폰 버그' });

    const rows = insertedResponses();
    const bodyOf = (id: string) => rows.find((r) => r.conversation_id === id)!.response_body as string;
    expect(bodyOf('c-en')).toContain('The problem you reported is fixed');
    expect(bodyOf('c-ko')).toContain('말씀해주신 문제를 고쳤어요');
    // locale 이 NULL 이면 예전처럼 제목에 한글이 있으니 ko
    expect(bodyOf('c-null')).toContain('말씀해주신 문제를 고쳤어요');
  });

  // 보안 리뷰 HIGH — 「재제보 합류」(B1)로 부르는 경로는 방문자가 스스로 연 «새» 대화에서
  // 출발한다. 연락처 이메일은 형식만 검증하고 저장하므로 남의 주소를 적어 넣을 수 있고,
  // 대화가 새로 생기니 유니크 인덱스도 못 막는다. 그래서 그 호출은 메일을 안 붙인다.
  it('skipEmail 이면 메일을 «한 통도» 안 보내고 행에 skipped 를 남긴다', async () => {
    prMerged = true;
    tables.insights = [{ id: 'i1', messages: { conversation_id: 'c-web' } }];
    tables.responses = [];
    tables.conversations = [{ id: 'c-web', source: 'web', external_user_id: 'v1' }];

    const res = await mod.closeLoopForRun(RUN, { skipEmail: true });

    expect(res.delivered).toBe(1); // 채널 전달은 그대로 — 막는 건 메일뿐이다
    expect(res.emailed).toBe(0);
    expect(emailed).toHaveLength(0);
    expect(insertedResponses()[0].email_delivery_status).toBe('skipped');
    expect(insertedResponses()[0].delivered_at).toBeTruthy();
  });

  it('skipped 로 찍힌 행은 «다음 크론»의 메일 회수에서도 빠진다', async () => {
    // 옵션이 한 번의 호출만 막고 행에 흔적을 안 남기면, 다음 크론이 같은 행을 pending 으로
    // 보고 주워서 결국 메일이 나간다 — 그러면 막은 것이 아니다.
    prMerged = true;
    tables.insights = [{ id: 'i1', messages: { conversation_id: 'c-web' } }];
    tables.conversations = [{ id: 'c-web', source: 'web', external_user_id: 'v1' }];
    tables.responses = [
      { id: 'r-rejoin', conversation_id: 'c-web', auto_dev_run_id: 'run-1', response_type: 'loop_closed', email_delivery_status: 'skipped' },
    ];

    const res = await mod.closeLoopForRun(RUN); // 크론 경로 — skipEmail 없음

    expect(res.skipped).toBe(1);
    expect(emailed).toHaveLength(0);
  });

  it('이미 되돌림을 받은 대화에는 두 번 보내지 않는다', async () => {
    prMerged = true;
    tables.insights = [{ id: 'i1', messages: { conversation_id: 'c-web' } }];
    tables.responses = [{ conversation_id: 'c-web' }];
    tables.conversations = [{ id: 'c-web', source: 'web' }];

    const res = await mod.closeLoopForRun(RUN);

    expect(res.delivered).toBe(0);
    expect(res.skipped).toBe(1);
    expect(inserted.find((i) => i.table === 'responses')).toBeUndefined();
  });

  it('머지로 확정되면 run 과 묶음 상태를 옮긴다', async () => {
    prMerged = true;
    tables.insights = [];
    const res = await mod.closeLoopForRun(RUN);

    expect(res.merged).toBe(true);
    expect(updated.find((u) => u.table === 'auto_dev_runs' && u.patch.merged_at)?.patch.merged_at).toBeTruthy();
    expect(updated.find((u) => u.table === 'insight_groups')?.patch.status).toBe('merged');
  });

  it('이미 merged_at 이 찍힌 run 은 GitHub 에 다시 묻지 않는다', async () => {
    prMerged = false;
    prFailure = false;
    deployments = [];
    deploymentStatuses = [];
    delete process.env.FEEDLOOP_DEPLOYMENT_ENVIRONMENT;
    tables.insights = [];
    const res = await mod.closeLoopForRun({ ...RUN, merged_at: '2026-09-06T00:00:00Z' });

    expect(res.merged).toBe(true);
    expect(prGetCalls).toBe(0);
  });

  it('PR 이 없는 run 은 건너뛴다', async () => {
    const res = await mod.closeLoopForRun({ ...RUN, pr_url: null, pr_number: null });
    expect(res.merged).toBe(false);
    expect(inserted).toHaveLength(0);
  });
});

describe('GitHub 왕복에 상한을 준다', () => {
  it('Octokit 에 요청 타임아웃을 주고 만든다 — 없으면 20회 ≈ 20초가 추정치일 뿐이다', async () => {
    prMerged = true;
    tables.insights = [];
    await mod.closeLoopForRun(RUN);

    expect(octokitOptions).toHaveLength(1);
    expect(octokitOptions[0]).toMatchObject({
      request: { timeout: mod.GITHUB_TIMEOUT_MS },
    });
  });
});

describe('채널톡 되돌림 — 우리가 직접 보낸다', () => {
  function channelSetup() {
    prMerged = true;
    tables.insights = [{ id: 'i1', messages: { conversation_id: 'c-ch' } }];
    tables.responses = [];
    tables.conversations = [
      {
        id: 'c-ch',
        source: 'channel',
        external_user_id: 'chat-1',
        channel_person_id: 'person-1',
        last_message_at: '2026-09-10T00:00:00Z',
      },
    ];
  }

  it('채널톡 대화면 전송을 시도한다', async () => {
    channelSetup();
    const res = await mod.closeLoopForRun(RUN);

    expect(res.delivered).toBe(1);
    expect(sendBotMessageMock).toHaveBeenCalledTimes(1);
    const [botId, chatId, body] = sendBotMessageMock.mock.calls[0] as unknown as [
      string,
      string,
      string,
    ];
    expect(botId).toBe('bot-1');
    expect(chatId).toBe('chat-1');
    // 문구는 파이프라인이 「머지됐어요 · 배포와 해결은 확인 중」으로 바꿨다. 카피를 박아두면
    // 문구를 고칠 때마다 채널 전송 테스트가 깨진다 — 「되돌림 본문을 그대로 보낸다」만 본다.
    expect(body).toBe(mod.buildLoopClosedBody(RUN.title, RUN.pr_number, RUN.pr_url));
  });

  it('행을 만들 때는 대기열로 두고, 보낸 뒤에 전달로 확정한다', async () => {
    channelSetup();
    await mod.closeLoopForRun(RUN);

    // 보내기 전에 delivered 로 찍으면 「보냈다고 기록된 안 보낸 행」이 생긴다.
    expect(insertedResponses()[0].delivered_at).toBeNull();
    expect(responseUpdates().some((u) => u.patch.delivered_at)).toBe(true);
  });

  it('전송이 실패하면 대기열에 남기고 시도 횟수와 사유를 남긴다', async () => {
    channelSetup();
    sendBotMessageMock.mockResolvedValue({ ok: false, status: 401, message: '키가 거부됐어요' });

    const res = await mod.closeLoopForRun(RUN);

    expect(res.deferred).toBe(0); // 시도는 했다 — 미룬 게 아니다
    expect(responseUpdates().some((u) => u.patch.delivered_at)).toBe(false);
    const failure = responseUpdates().find((u) => u.patch.delivery_attempts !== undefined);
    expect(failure!.patch).toMatchObject({ delivery_attempts: 1, delivery_error: '키가 거부됐어요' });
  });

  it('한 사람이 유저챗을 2개 열었어도 되돌림은 1건이다', async () => {
    prMerged = true;
    tables.insights = [
      { id: 'i1', messages: { conversation_id: 'c-old' } },
      { id: 'i2', messages: { conversation_id: 'c-new' } },
    ];
    tables.responses = [];
    tables.conversations = [
      {
        id: 'c-old',
        source: 'channel',
        external_user_id: 'chat-old',
        channel_person_id: 'person-1',
        last_message_at: '2026-09-01T00:00:00Z',
      },
      {
        id: 'c-new',
        source: 'channel',
        external_user_id: 'chat-new',
        channel_person_id: 'person-1',
        last_message_at: '2026-09-10T00:00:00Z',
      },
    ];

    const res = await mod.closeLoopForRun(RUN);

    expect(res.delivered).toBe(1);
    expect(insertedResponses()).toHaveLength(1);
    // 전송 대상은 마지막으로 말한 챗이다 — 열려 있을 가능성이 높다.
    expect((sendBotMessageMock.mock.calls[0] as unknown as string[])[1]).toBe('chat-new');
  });

  it('같은 run 을 다시 돌려도 그 사람에게 두 번 가지 않는다', async () => {
    prMerged = true;
    tables.insights = [
      { id: 'i1', messages: { conversation_id: 'c-old' } },
      { id: 'i2', messages: { conversation_id: 'c-new' } },
    ];
    // 지난번에 c-new 로 보냈다. 같은 사람의 c-old 로 다시 가면 안 된다.
    tables.responses = [{ conversation_id: 'c-new' }];
    tables.conversations = [
      {
        id: 'c-old',
        source: 'channel',
        external_user_id: 'chat-old',
        channel_person_id: 'person-1',
        last_message_at: '2026-09-01T00:00:00Z',
      },
      {
        id: 'c-new',
        source: 'channel',
        external_user_id: 'chat-new',
        channel_person_id: 'person-1',
        last_message_at: '2026-09-10T00:00:00Z',
      },
    ];

    const res = await mod.closeLoopForRun(RUN);

    expect(res.delivered).toBe(0);
    expect(res.skipped).toBe(1);
    expect(sendBotMessageMock).not.toHaveBeenCalled();
  });

  it('마감이 지났으면 보내지 않고 미룬 것으로 센다', async () => {
    channelSetup();
    const res = await mod.closeLoopForRun(RUN, { sendDeadline: clock - 1 });

    expect(res.delivered).toBe(1); // 행은 만들었다
    expect(res.deferred).toBe(1); // 보내지는 못했다
    expect(sendBotMessageMock).not.toHaveBeenCalled();
    expect(insertedResponses()[0].delivered_at).toBeNull();
  });
});

describe('checkMergedRuns — 예산은 호출부에서 재고 두 반복 모두에 건다', () => {
  function runsFixture(count: number) {
    tables.auto_dev_runs = Array.from({ length: count }, (_, i) => ({
      id: `run-${i}`,
      bot_id: 'bot-1',
      group_id: `g-${i}`,
      insight_id: null,
      pr_url: 'https://github.com/o/r/pull/1',
      pr_number: 1,
      merged_at: null,
      insight_groups: { title: '쿠폰' },
      insights: null,
    }));
  }

  it('결과와 「못 본 run 수」를 함께 돌려준다', async () => {
    runsFixture(1);
    prMerged = true;
    tables.insights = [];

    const out = await mod.checkMergedRuns(['bot-1']);

    expect(out.results).toHaveLength(1);
    expect(out.skipped).toBe(0);
  });

  it('봇이 없으면 아무것도 하지 않는다', async () => {
    expect(await mod.checkMergedRuns([])).toEqual({ results: [], skipped: 0 });
  });

  it('열린 초안은 같은 봇 자격·레포·타임아웃으로 승격 판정한다', async () => {
    runsFixture(1);
    prDraft = true;
    prBody = '## 자동 검사 대기';
    const out = await mod.checkMergedRuns(['bot-1']);
    expect(out.results).toHaveLength(1);
    expect(out.results[0].merged).toBe(false);
    expect(reviewAndPromoteDraft).toHaveBeenCalledWith('https://github.com/o/r', 1, { botId: 'bot-1', timeoutMs: mod.GITHUB_TIMEOUT_MS, signal: expect.any(AbortSignal) });
    expect(inserted).toHaveLength(0);
  });

  it('ready 자동 PR은 게이트를 다시 방문하지 않는다', async () => {
    runsFixture(1);
    prBody = '## 자동 검사 대기';
    await mod.checkMergedRuns(['bot-1']);
    expect(reviewAndPromoteDraft).not.toHaveBeenCalled();
  });

  it('닫히거나 머지된 초안에는 승격하지 않는다', async () => {
    runsFixture(1);
    prDraft = true;
    prState = 'closed';
    await mod.checkMergedRuns(['bot-1']);
    expect(reviewAndPromoteDraft).not.toHaveBeenCalled();
    prMerged = true;
    tables.insights = [];
    await mod.checkMergedRuns(['bot-1']);
    expect(reviewAndPromoteDraft).not.toHaveBeenCalled();
  });

  it('게이트 오류는 열린 PR 사실을 유지하고 다음 run도 확인한다', async () => {
    runsFixture(2);
    prDraft = true;
    prBody = '## 자동 검사 대기';
    reviewAndPromoteDraft.mockRejectedValueOnce(new Error('GraphQL unavailable'));
    const out = await mod.checkMergedRuns(['bot-1']);
    expect(out.results).toHaveLength(2);
    expect(out.results[0].error).toBeUndefined();
    expect(out.results[0].merged).toBe(false);
    expect(out.results[1].error).toBeUndefined();
    expect(updated.some(row => row.patch.follow_up_error === 'GraphQL unavailable')).toBe(false);
  });

  it('대기 절 없는 기존 PR을 사람이 초안으로 바꿔도 게이트를 방문하지 않는다', async () => {
    runsFixture(1);
    prDraft = true;
    await mod.checkMergedRuns(['bot-1']);
    expect(reviewAndPromoteDraft).not.toHaveBeenCalled();
  });

  it('run 루프 마감을 넘기면 남은 run 은 GitHub 에 묻지도 않고 skipped 로 센다', async () => {
    runsFixture(3);
    prMerged = true;
    tables.insights = [];
    // run 하나가 40초씩 걸리면 70초 마감에서 셋째는 시작하지 못한다.
    prGetCostMs = 40_000;

    const out = await mod.checkMergedRuns(['bot-1']);

    expect(out.results).toHaveLength(2);
    expect(out.skipped).toBe(1);
    expect(prGetCalls).toBe(2);
  });

  it('run 여러 개가 채널톡 예산을 «공유»한다 — run 당 상한만으로는 20배가 된다', async () => {
    // 수용 기준 32: run 5개 × 사람 3명 = 15건, 전송 1건에 2.5초.
    // 공유 예산 30초면 12건이 나가고 나머지는 미뤄진다.
    runsFixture(5);
    prMerged = true;
    sendCostMs = 2_500;

    tables.insights = [
      { id: 'i1', messages: { conversation_id: 'c-1' } },
      { id: 'i2', messages: { conversation_id: 'c-2' } },
      { id: 'i3', messages: { conversation_id: 'c-3' } },
    ];
    tables.responses = [];
    tables.conversations = [1, 2, 3].map((n) => ({
      id: `c-${n}`,
      source: 'channel',
      external_user_id: `chat-${n}`,
      channel_person_id: `person-${n}`,
      last_message_at: '2026-09-10T00:00:00Z',
    }));

    const started = clock;
    const out = await mod.checkMergedRuns(['bot-1']);
    const elapsed = clock - started;

    expect(sendBotMessageMock).toHaveBeenCalledTimes(12);
    const deferred = out.results.reduce((sum, r) => sum + r.deferred, 0);
    expect(deferred).toBe(3);

    // 예산 30초 + 마감 직전 시작분 1건. 40초 안에 끝나야 120초 한도에 여유가 남는다.
    expect(elapsed).toBeLessThan(40_000);
    // run 당 상한(5)은 3명이라 안 걸린다 — 공유 예산만이 유일한 제동이다.
    expect(mod.CHANNEL_SEND_MAX_PER_RUN).toBeGreaterThan(3);
  });

  it('run 하나가 예산을 독식하지 못한다', async () => {
    runsFixture(1);
    prMerged = true;
    tables.insights = Array.from({ length: 8 }, (_, i) => ({
      id: `i-${i}`,
      messages: { conversation_id: `c-${i}` },
    }));
    tables.responses = [];
    tables.conversations = Array.from({ length: 8 }, (_, i) => ({
      id: `c-${i}`,
      source: 'channel',
      external_user_id: `chat-${i}`,
      channel_person_id: `person-${i}`,
      last_message_at: '2026-09-10T00:00:00Z',
    }));

    const out = await mod.checkMergedRuns(['bot-1']);

    expect(sendBotMessageMock).toHaveBeenCalledTimes(mod.CHANNEL_SEND_MAX_PER_RUN);
    expect(out.results[0].deferred).toBe(8 - mod.CHANNEL_SEND_MAX_PER_RUN);
  });
});

describe('deployment evidence never implies user resolution',()=>{
 it('requires configured environment and exact merge SHA',async()=>{
  expect(await mod.checkDeployment(RUN.pr_url,'abc')).toEqual({status:'unknown',reason:'environment_not_configured'});
  process.env.FEEDLOOP_DEPLOYMENT_ENVIRONMENT='qa';
  expect(await mod.checkDeployment(RUN.pr_url)).toEqual({status:'unknown',reason:'merge_sha_unknown'});
  deployments=[{id:1,sha:'different',environment:'qa',created_at:'2026-09-13'}];
  expect((await mod.checkDeployment(RUN.pr_url,'abc')).status).toBe('unknown');
 });
 it('latest attempt failure is separate from merge and prior success',async()=>{
  process.env.FEEDLOOP_DEPLOYMENT_ENVIRONMENT='qa';
  deployments=[{id:1,sha:'abc',environment:'qa',created_at:'2026-09-13'}];
  deploymentStatuses=[{state:'success',environment:'qa',created_at:'2026-09-12'},{state:'failure',environment:'qa',created_at:'2026-09-13'}];
  expect(await mod.checkDeployment(RUN.pr_url,'abc')).toEqual({status:'failed',reason:'failure'});
  deploymentStatuses=[{state:'success',environment:'production',created_at:'2026-09-13'}];
  expect((await mod.checkDeployment(RUN.pr_url,'abc')).status).toBe('unknown');
 });
});

it("follow-up queue lookup failure is not an empty successful scan", async () => {
  queryError = { message: "database unavailable" };
  await expect(mod.checkMergedRuns(["b1"])).rejects.toThrow("follow_up_lookup_failed");
});

it('per-run external failure remains in the returned scan denominator', async () => {
  prFailure = true;
  tables.auto_dev_runs = [{ id: 'r1', bot_id: 'b1', pr_url: 'https://github.com/owner/repo/pull/1', pr_number: 1 }];
  // 반환형은 `{ results, skipped }` 다 — `skipped`(마감에 걸려 못 본 run)는 실패와 다른
  // 사건이라 채널톡 회차가 따로 세게 만들었다. 실패한 run 도 분모(results)에는 남는다.
  const { results } = await mod.checkMergedRuns(['b1']);
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ runId: 'r1', error: 'github unavailable', delivered: 0 });
  expect(updated).toContainEqual(expect.objectContaining({ patch: expect.objectContaining({ follow_up_error: 'github unavailable' }) }));
});
