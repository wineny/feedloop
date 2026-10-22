// B1 — 기존 묶음 대조의 판단과, 머지된 묶음에 «합류» 했을 때의 되돌림.
//
// 되돌림 생성은 `closeLoopForRun` 을 그대로 쓴다(중복 구현 금지). 그래서 여기서는 그 함수를
// 모킹하지 «않고» 진짜로 태운다 — 웹은 delivered_at 이 찍히고 카카오는 대기열로 남는다는
// 규칙이 되돌림 경로 전체에서 실제로 성립하는지가 이 파일이 지키는 것이다.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const tables: Record<string, unknown[]> = {};
let queryError: { message: string } | null = null;
const inserted: { table: string; rows: Record<string, unknown>[] }[] = [];
const updated: { table: string; patch: Record<string, unknown> }[] = [];
/** 조회마다 쓰인 필터. 「최근 30개만 읽었는가」처럼 쿼리 자체를 볼 때 쓴다. */
const queries: { table: string; filters: [string, unknown][]; limit: number | null; order: [string, boolean][] }[] = [];

let insertSeq = 0;

function chain(table: string) {
  const c: Record<string, unknown> = {};
  const filters: [string, unknown][] = [];
  const order: [string, boolean][] = [];
  let limit: number | null = null;

  for (const m of ['in', 'is', 'not', 'lt', 'gt', 'gte']) c[m] = vi.fn(() => c);
  const excluded: [string, unknown][] = [];
  c.neq = vi.fn((col: string, value: unknown) => {
    excluded.push([col, value]);
    return c;
  });
  c.eq = vi.fn((col: string, value: unknown) => {
    filters.push([col, value]);
    return c;
  });
  c.order = vi.fn((col: string, opts?: { ascending?: boolean }) => {
    order.push([col, opts?.ascending !== false]);
    return c;
  });
  c.limit = vi.fn((n: number) => {
    limit = n;
    return c;
  });

  // `eq` 는 진짜로 적용한다 — 흉내만 내면 남의 봇 행을 읽고도 초록이 된다.
  // 값을 안 가진 픽스처 행은 통과시킨다(최소한으로 적어둔 픽스처가 뜻대로 읽히게).
  const rows = () => {
    const out = (tables[table] ?? []).filter((row) => {
      const r = row as Record<string, unknown>;
      return (
        filters.every(([col, value]) => !(col in r) || r[col] === value) &&
        excluded.every(([col, value]) => !(col in r) || r[col] !== value)
      );
    });
    queries.push({ table, filters, limit, order });
    return limit === null ? out : out.slice(0, limit);
  };

  c.maybeSingle = vi.fn(async () => ({ data: rows()[0] ?? null, error: queryError }));
  c.single = vi.fn(async () => ({ data: rows()[0] ?? null, error: queryError }));
  c.then = (resolve: (v: unknown) => void) => resolve({ data: rows(), error: queryError });
  return c;
}

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: vi.fn((table: string) => ({
      select: vi.fn(() => chain(table)),
      upsert: vi.fn((rows: unknown) => {
        const list = (Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[];
        inserted.push({ table, rows: list });
        const created = list.map((r) => {
          insertSeq += 1;
          return { ...r, id: `${table}-${insertSeq}` };
        });
        tables[table] = [...(tables[table] ?? []), ...created];
        const withIds = created.map((r) => ({
          id: r.id as string,
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

const sendBotMessageMock = vi.fn(async () => ({ ok: true }) as { ok: boolean; message?: string });
vi.mock('@/lib/channel/client', () => ({ sendBotMessage: sendBotMessageMock }));

const emailed: Record<string, unknown>[] = [];
vi.mock('@/lib/email/notify', () => ({
  emailResponse: vi.fn(async (input: Record<string, unknown>) => {
    emailed.push(input);
    return { sent: false, reason: 'no_email' };
  }),
}));

// 되돌림이 GitHub 을 다시 묻지 않는 것(merged_at 이 이미 있으므로)을 확실히 하려고
// 토큰 경로 자체를 막는다 — 실수로 호출되면 테스트가 «여기서» 깨진다.
vi.mock('@/lib/auto-dev/github-auth', () => ({
  octokitForBot: vi.fn(async () => {
    throw new Error('github should not be called');
  }),
  noteGithubError: vi.fn(async () => {}),
}));

type Mod = typeof import('@/lib/groups/existing-match');
let mod: Mod;

const BOT = 'bot-1';

beforeEach(async () => {
  vi.clearAllMocks();
  queryError = null;
  for (const k of Object.keys(tables)) delete tables[k];
  inserted.length = 0;
  updated.length = 0;
  queries.length = 0;
  emailed.length = 0;
  insertSeq = 0;
  delete process.env.FEEDLOOP_DEPLOYMENT_ENVIRONMENT;
  sendBotMessageMock.mockImplementation(async () => ({ ok: true }));
  vi.resetModules();
  mod = await import('@/lib/groups/existing-match');
});

afterEach(() => vi.restoreAllMocks());

describe('대조 판단 — 상태 하나로 갈린다', () => {
  it('닫힌 묶음에만 합류하지 않는다', () => {
    expect(mod.matchOutcome('open')).toBe('join');
    expect(mod.matchOutcome('pr_created')).toBe('join');
    expect(mod.matchOutcome('merged')).toBe('join');
    expect(mod.matchOutcome('dismissed')).toBe('new');
  });

  it('되돌림을 지금 만드는 것은 머지된 묶음뿐 — pr_created 는 머지 때 함께 나간다', () => {
    expect(mod.needsLoopClosed('merged')).toBe(true);
    expect(mod.needsLoopClosed('pr_created')).toBe(false);
    expect(mod.needsLoopClosed('open')).toBe(false);
    expect(mod.needsLoopClosed('dismissed')).toBe(false);
  });
});

describe('listRecentGroups — 즉답(F1)이 쓰는 목록', () => {
  beforeEach(() => {
    tables.insight_groups = [
      { id: 'g3', title: '셋', summary: 's', category: 'bug', status: 'open' },
      { id: 'g2', title: '둘', summary: 's', category: 'bug', status: 'merged' },
      { id: 'g1', title: '하나', summary: 's', category: 'ux', status: 'dismissed' },
    ];
  });

  it('봇으로 좁히고 최신순 상한을 걸어 읽는다', async () => {
    await mod.listRecentGroups(BOT);
    const q = queries.find((x) => x.table === 'insight_groups')!;
    expect(q.filters).toContainEqual(['bot_id', BOT]);
    expect(q.limit).toBe(mod.EXISTING_GROUPS_LIMIT);
    expect(q.order[0]).toEqual(['created_at', false]); // 최신부터 골라야 최근 것이 남는다
  });

  it('고른 뒤에는 오래된 것부터 돌려준다 — 스냅샷 RPC 와 같은 순서', async () => {
    const out = await mod.listRecentGroups(BOT);
    expect(out.map((g) => g.id)).toEqual(['g1', 'g2', 'g3']);
  });

  it('조회 실패를 빈 목록으로 접지 않는다 — 대조가 조용히 꺼지면 안 된다', async () => {
    queryError = { message: 'boom' };
    await expect(mod.listRecentGroups(BOT)).rejects.toThrow('existing_groups_lookup_failed');
  });

  it('joinableOnly 면 닫힌 묶음을 아예 읽지 않는다', async () => {
    const out = await mod.listRecentGroups(BOT, { joinableOnly: true });
    expect(out.map((g) => g.id)).toEqual(['g2', 'g3']);
  });

  it('PR 은 같은 조회에서 함께 읽는다 — 머지된 run 이 있으면 그것을 고른다', async () => {
    tables.insight_groups = [
      {
        id: 'g1', title: '하나', summary: 's', category: 'bug', status: 'merged',
        auto_dev_runs: [
          { pr_number: 4, pr_url: 'https://github.com/o/r/pull/4', merged_at: null },
          { pr_number: 12, pr_url: 'https://github.com/o/r/pull/12', merged_at: '2026-09-16T00:00:00Z' },
        ],
      },
    ];
    const [g] = await mod.listRecentGroups(BOT);
    expect(g.prNumber).toBe(12);
    expect(g.prUrl).toBe('https://github.com/o/r/pull/12');
  });

  it('비머지 폴백은 임베드 순서가 아니라 값으로 고른다 — 숫자가 요청마다 흔들리면 안 된다', async () => {
    const runs = [
      { pr_number: 5, pr_url: 'u5', merged_at: null, created_at: '2026-09-10T00:00:00Z' },
      { pr_number: 9, pr_url: 'u9', merged_at: null, created_at: '2026-09-14T00:00:00Z' },
      { pr_number: 7, pr_url: 'u7', merged_at: null, created_at: '2026-09-12T00:00:00Z' },
    ];
    for (const order of [runs, [...runs].reverse(), [runs[2], runs[0], runs[1]]]) {
      tables.insight_groups = [
        { id: 'g1', title: '하나', summary: 's', category: 'bug', status: 'pr_created', auto_dev_runs: order },
      ];
      const [g] = await mod.listRecentGroups(BOT);
      expect(g.prNumber).toBe(9); // 가장 최근에 연 PR
    }
  });

  it('머지된 run 이 없으면 PR 이 열린 run 을, 그것도 없으면 null 을 준다', async () => {
    tables.insight_groups = [
      { id: 'g1', title: '하나', summary: 's', category: 'bug', status: 'pr_created',
        auto_dev_runs: [{ pr_number: 7, pr_url: 'https://github.com/o/r/pull/7', merged_at: null }] },
      { id: 'g2', title: '둘', summary: 's', category: 'bug', status: 'open', auto_dev_runs: [] },
    ];
    const out = await mod.listRecentGroups(BOT);
    expect(out.find((g) => g.id === 'g1')!.prNumber).toBe(7);
    expect(out.find((g) => g.id === 'g2')!.prNumber).toBeNull();
  });
});

// ── F1 — 즉답 문구는 서버가 확정한다 ────────────────────────────────────────

const replyGroup = (over: Partial<mod2ReplyGroup> & { id: string }): mod2ReplyGroup => ({
  title: '쿠폰함 흰 화면', summary: 's', category: 'bug', status: 'open',
  prNumber: null, prUrl: null, ...over,
});
type mod2ReplyGroup = import('@/lib/groups/existing-match').ReplyGroup;

describe('buildKnownIssueReply — 없는 PR 번호를 지어내지 않는다', () => {
  it('머지됨이면 「이미 반영됐어요 (수정 #N)」', () => {
    expect(mod.buildKnownIssueReply(replyGroup({ id: 'g', status: 'merged', prNumber: 12 })))
      .toBe('이 문제는 이미 반영됐어요 (수정 #12). 혹시 아직 그대로면 알려주세요 🙏');
  });

  it('pr_created 면 「지금 고치는 중이에요 (수정 #N)」', () => {
    expect(mod.buildKnownIssueReply(replyGroup({ id: 'g', status: 'pr_created', prNumber: 7 })))
      .toContain('지금 고치는 중이에요 (수정 #7)');
  });

  it('PR 번호가 없으면 번호를 빼고 말한다', () => {
    const out = mod.buildKnownIssueReply(replyGroup({ id: 'g', status: 'merged', prNumber: null }));
    expect(out).toContain('이미 반영됐어요');
    expect(out).not.toContain('수정 #');
  });

  it('열린 묶음은 진행 상황을 단정하지 않는다 — PR 이 아직 없다', () => {
    const out = mod.buildKnownIssueReply(replyGroup({ id: 'g', status: 'open' }))!;
    expect(out).toContain('함께 보고 있어요');
    expect(out).not.toContain('수정 #');
    expect(out).not.toContain('고치는 중');
  });

  it('닫힌 묶음에는 해줄 말이 없다 (null)', () => {
    expect(mod.buildKnownIssueReply(replyGroup({ id: 'g', status: 'dismissed', prNumber: 3 }))).toBeNull();
  });

  it('묶음 제목을 방문자에게 되풀이하지 않는다 — 남의 말이다', () => {
    const out = mod.buildKnownIssueReply(replyGroup({ id: 'g', status: 'merged', prNumber: 1, title: '남이 쓴 제목' }))!;
    expect(out).not.toContain('남이 쓴 제목');
  });
});

describe('knownIssueMode — 언제 덮고 언제 덧붙이는가', () => {
  it('merged·pr_created 는 대체 — 서버가 아는 사실이 모델 짐작보다 정확하다', () => {
    expect(mod.knownIssueMode('merged')).toBe('replace');
    expect(mod.knownIssueMode('pr_created')).toBe('replace');
  });

  it('open 은 덧붙이기 — 「접수돼 있다」는 그 사람 질문에 대한 답이 아니다', () => {
    expect(mod.knownIssueMode('open')).toBe('append');
  });
});

describe('resolveKnownIssue / formatKnownIssuesSection', () => {
  const groups = [
    replyGroup({ id: 'g-merged', status: 'merged', prNumber: 12 }),
    replyGroup({ id: 'g-dismissed', status: 'dismissed' }),
  ];
  const refFor = (id: string) =>
    [...mod.buildGroupRefMap(groups)].find(([, g]) => g.id === id)![0];

  it('목록 안 ref 면 묶음과 문구를 준다. merged 는 모델 문장을 버린다', () => {
    const out = mod.resolveKnownIssue(refFor('g-merged'), mod.buildGroupRefMap(groups), '모델이 쓴 말')!;
    expect(out.group.id).toBe('g-merged');
    expect(out.mode).toBe('replace');
    expect(out.reply).toContain('(수정 #12)');
    expect(out.reply).not.toContain('모델이 쓴 말');
  });

  it('모델이 ref 를 대괄호째 적어도 같은 묶음을 찾는다', () => {
    const open = [replyGroup({ id: 'g-open', status: 'open' })];
    const ref = [...mod.buildGroupRefMap(open)][0][0];
    expect(mod.resolveKnownIssue(`[${ref}]`, mod.buildGroupRefMap(open), null)!.group.id).toBe('g-open');
  });

  it('열린 묶음이면 모델 문장을 살리고 뒤에 한 줄을 덧붙인다', () => {
    const open = [replyGroup({ id: 'g-open', status: 'open' })];
    const ref = [...mod.buildGroupRefMap(open)][0][0];
    const out = mod.resolveKnownIssue(ref, mod.buildGroupRefMap(open), '어떤 화면에서 그러셨어요?')!;
    expect(out.mode).toBe('append');
    expect(out.reply.startsWith('어떤 화면에서 그러셨어요?')).toBe(true);
    expect(out.reply).toContain('함께 보고 있어요');
  });

  it('덧붙이기인데 모델이 답을 못 냈으면 서버 문장만 나간다', () => {
    const open = [replyGroup({ id: 'g-open', status: 'open' })];
    const ref = [...mod.buildGroupRefMap(open)][0][0];
    expect(mod.resolveKnownIssue(ref, mod.buildGroupRefMap(open), null)!.reply)
      .toBe('같은 문제를 말한 분이 또 있어 함께 보고 있어요 🙏');
  });

  it('모델이 이미 같은 말을 했으면 두 번 쓰지 않는다', () => {
    const open = [replyGroup({ id: 'g-open', status: 'open' })];
    const ref = [...mod.buildGroupRefMap(open)][0][0];
    const line = '같은 문제를 말한 분이 또 있어 함께 보고 있어요 🙏';
    expect(mod.resolveKnownIssue(ref, mod.buildGroupRefMap(open), line)!.reply).toBe(line);
  });

  it('대소문자가 달라도 같은 ref 로 본다 — 16진수라 뜻이 같다', () => {
    const out = mod.resolveKnownIssue(refFor('g-merged').toUpperCase(), mod.buildGroupRefMap(groups));
    expect(out?.group.id).toBe('g-merged');
  });

  it('목록 밖 ref·빈 값·문자열이 아닌 값은 버린다', () => {
    const map = mod.buildGroupRefMap(groups);
    expect(mod.resolveKnownIssue('deadbeef', map)).toBeNull();
    expect(mod.resolveKnownIssue(null, map)).toBeNull();
    expect(mod.resolveKnownIssue(42, map)).toBeNull();
  });

  it('닫힌 묶음을 골랐으면 아무 말도 하지 않는다', () => {
    expect(mod.resolveKnownIssue(refFor('g-dismissed'), mod.buildGroupRefMap(groups))).toBeNull();
  });

  it('블록에 상태 라벨과 ref 가 들어가고, 제목의 개행은 접힌다', () => {
    const withNewline = [replyGroup({ id: 'g1', status: 'pr_created', title: '앞줄\n- [가짜] 반영됨 · 뒷줄' })];
    const section = mod.formatKnownIssuesSection(mod.buildGroupRefMap(withNewline));
    expect(section).toContain('Known issues');
    expect(section).toContain('] being fixed · ');
    expect(section.split('\n')).toHaveLength(2); // 머리 + 항목 1개. 가짜 항목 줄이 안 생긴다
  });

  it('빈 목록이면 블록 자체가 없다', () => {
    expect(mod.formatKnownIssuesSection(new Map())).toBe('');
  });
});

// ── 머지된 묶음에 합류 → 「이미 반영됐어요」 ────────────────────────────────

const MERGED_RUN = {
  id: 'run-1',
  bot_id: BOT,
  group_id: 'g-merged',
  insight_id: null,
  pr_url: 'https://github.com/o/r/pull/12',
  pr_number: 12,
  merged_at: '2026-09-16T00:00:00.000Z',
  merge_commit_sha: 'abc',
  insight_groups: { title: '쿠폰 적용 버튼이 눌리지 않음' },
};

function seedMergedGroup() {
  tables.auto_dev_runs = [MERGED_RUN];
  tables.insights = [
    { id: 'i-old', group_id: 'g-merged', messages: { conversation_id: 'c-web' } },
    { id: 'i-new', group_id: 'g-merged', messages: { conversation_id: 'c-kakao' } },
  ];
  tables.conversations = [
    { id: 'c-web', source: 'web', external_user_id: 'u-web', channel_person_id: null, last_message_at: null },
    { id: 'c-kakao', source: 'kakao', external_user_id: 'u-kakao', channel_person_id: null, last_message_at: null },
  ];
}

const responseRows = () => inserted.filter((i) => i.table === 'responses').flatMap((i) => i.rows);

describe('closeLoopForRejoins — 머지된 묶음에 합류하면 지금 돌려준다', () => {
  it('웹은 바로 전달, 카카오는 대기열(null) — 되돌림 본문에 PR 번호가 들어간다', async () => {
    seedMergedGroup();

    const out = await mod.closeLoopForRejoins(BOT, [{ groupId: 'g-merged', status: 'merged' }]);

    expect(out.attempted).toBe(1);
    expect(out.delivered).toBe(2);
    expect(out.failures).toEqual([]);

    const rows = responseRows();
    expect(rows).toHaveLength(2);
    const web = rows.find((r) => r.conversation_id === 'c-web')!;
    const kakao = rows.find((r) => r.conversation_id === 'c-kakao')!;
    expect(web.delivered_at).toEqual(expect.any(String));
    expect(kakao.delivered_at).toBeNull();
    expect(rows.every((r) => r.response_type === 'loop_closed')).toBe(true);
    expect(rows.every((r) => r.auto_dev_run_id === 'run-1')).toBe(true);
    expect(String(web.response_body)).toContain('(수정 #12)');
    expect(String(web.response_body)).toContain('쿠폰 적용 버튼이 눌리지 않음');
    // 보안 리뷰 HIGH — 합류 되돌림에는 **메일을 붙이지 않는다.** 이 경로는 방문자가 스스로
    // 연 새 대화에서 출발하고 그 대화의 이메일은 형식 검증만 거친 값이다.
    expect(emailed).toEqual([]);
    expect(rows.every((r) => r.email_delivery_status === 'skipped')).toBe(true);
  });

  it('열림·pr_created 묶음에는 되돌림을 만들지 않는다 — 머지 때 다른 사람들과 함께 나간다', async () => {
    seedMergedGroup();

    const out = await mod.closeLoopForRejoins(BOT, [
      { groupId: 'g-open', status: 'open' },
      { groupId: 'g-pr', status: 'pr_created' },
      { groupId: 'g-dismissed', status: 'dismissed' },
    ]);

    expect(out.attempted).toBe(0);
    expect(out.delivered).toBe(0);
    expect(responseRows()).toEqual([]);
  });

  it('이미 되돌림을 받은 대화에는 또 만들지 않는다 (멱등)', async () => {
    seedMergedGroup();
    tables.responses = [
      { id: 'r-old', conversation_id: 'c-web', auto_dev_run_id: 'run-1', response_type: 'loop_closed' },
    ];

    const out = await mod.closeLoopForRejoins(BOT, [{ groupId: 'g-merged', status: 'merged' }]);

    expect(out.delivered).toBe(1);
    expect(responseRows().map((r) => r.conversation_id)).toEqual(['c-kakao']);
  });

  it('같은 회차를 두 번 돌려도 되돌림이 늘지 않는다', async () => {
    seedMergedGroup();
    await mod.closeLoopForRejoins(BOT, [{ groupId: 'g-merged', status: 'merged' }]);
    inserted.length = 0;

    const again = await mod.closeLoopForRejoins(BOT, [{ groupId: 'g-merged', status: 'merged' }]);

    expect(again.delivered).toBe(0);
    expect(responseRows()).toEqual([]);
  });

  it('머지 run 이 없는 merged 묶음은 건너뛴다 — PR 번호 없이 「반영됐어요」라고 하지 않는다', async () => {
    tables.auto_dev_runs = [];
    tables.insights = [];
    tables.conversations = [];

    const out = await mod.closeLoopForRejoins(BOT, [{ groupId: 'g-merged', status: 'merged' }]);

    expect(out.attempted).toBe(1);
    expect(out.skippedNoRun).toBe(1);
    expect(out.delivered).toBe(0);
    expect(responseRows()).toEqual([]);
  });

  it('남의 봇 run 은 읽지 않는다', async () => {
    seedMergedGroup();
    await mod.closeLoopForRejoins(BOT, [{ groupId: 'g-merged', status: 'merged' }]);
    const q = queries.find((x) => x.table === 'auto_dev_runs')!;
    expect(q.filters).toContainEqual(['bot_id', BOT]);
    expect(q.filters).toContainEqual(['group_id', 'g-merged']);
  });

  it('같은 묶음이 두 번 들어와도 한 번만 태운다', async () => {
    seedMergedGroup();

    const out = await mod.closeLoopForRejoins(BOT, [
      { groupId: 'g-merged', status: 'merged' },
      { groupId: 'g-merged', status: 'merged' },
    ]);

    expect(out.attempted).toBe(1);
    expect(responseRows()).toHaveLength(2); // 대화 2개 × 1회
  });

  it('한 회차가 볼 묶음 수에 상한이 있다 — 넘긴 것은 크론이 줍는다', async () => {
    seedMergedGroup();
    const many = Array.from({ length: mod.REJOIN_MAX_GROUPS + 3 }, (_, i) => ({
      groupId: `g${i}`,
      status: 'merged',
    }));

    const out = await mod.closeLoopForRejoins(BOT, many);

    expect(out.attempted).toBe(mod.REJOIN_MAX_GROUPS);
    expect(out.skippedDeadline).toBe(3);
  });

  it('마감이 지났으면 시작하지 않는다 — 자동 묶기 예산을 다 먹지 않게', async () => {
    seedMergedGroup();

    const out = await mod.closeLoopForRejoins(
      BOT,
      [{ groupId: 'g-merged', status: 'merged' }],
      { deadlineMs: Date.now() - 1 },
    );

    expect(out.attempted).toBe(0);
    expect(out.skippedDeadline).toBe(1);
    expect(responseRows()).toEqual([]);
  });

  it('실패를 삼키지 않고 이유와 함께 올린다', async () => {
    seedMergedGroup();
    queryError = { message: 'auto_dev_runs gone' };

    const out = await mod.closeLoopForRejoins(BOT, [{ groupId: 'g-merged', status: 'merged' }]);

    expect(out.delivered).toBe(0);
    expect(out.failures[0]).toContain('loop_closed_failed(g-merged)');
    expect(out.failures[0]).toContain('auto_dev_runs gone');
  });
});
