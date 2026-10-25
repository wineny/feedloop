// 대시보드 지표 조회의 «계약» 테스트 — 누가 이 줄들을 지우면 여기서 깨져야 한다.
//
// 지키는 것 셋:
//   ① 새 조회 넷(앵커·fixed·not_fixed·전달됨·레포)이 전부 소유 봇으로 좁혀져 있다(`in('bot_id'|'id')`)
//   ② 앵커 조회는 정렬·상한이 있고, 상한에 닿으면 평균을 내지 않는다
//   ③ 되돌림 확인은 분자·분모가 **같은 모집단**(web 대화)을 본다
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { from, resolveOwnedBots, results, calls } = vi.hoisted(() => ({
  from: vi.fn(),
  resolveOwnedBots: vi.fn(),
  results: [] as unknown[],
  calls: [] as { table: string; methods: [string, ...unknown[]][] }[],
}));
vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: () => ({ from }) }));
vi.mock('@/lib/auth/ownership', () => ({ resolveOwnedBots, resolveAccessibleBots: resolveOwnedBots }));
import { GET } from '@/app/api/dashboard/route';

const BOT = 'owned-bot';
const REPORTED_AT = '2026-09-15T00:00:00.000Z';
const DELIVERED_AT = '2026-09-17T00:00:00.000Z';
const TWO_DAYS = 2 * 24 * 3_600_000;

/** 앞선 조회들(개수 10 + 입구 3)을 기본값으로 흘려보낸다 — 이 테스트가 보는 건 그 뒤다. */
function pushLeadingCounts() {
  for (let i = 0; i < 13; i += 1) results.push({ count: 0, error: null });
}

/** 되돌림 1건 + 그 실행에 묶인 제보 1건. 앵커 조회가 실제로 돌게 하는 최소 자료. */
function pushLoopFixtures(anchor: unknown = { data: [{ id: 'msg-1', conversation_id: 'conv-1', detected_at: REPORTED_AT }], error: null }) {
  results.push({ data: [], error: null }); // messages(최근 목록)
  results.push({ data: [{ id: 'ins-1', message_id: 'msg-1', source_message_ids: [], group_id: null, category: 'bug', summary: '제보', created_at: REPORTED_AT }], error: null });
  results.push({ data: [{ trigger_message_id: null, conversation_id: 'conv-1', response_type: 'loop_closed', response_body: '반영됐어요', sent_at: DELIVERED_AT, delivered_at: DELIVERED_AT, auto_dev_run_id: 'run-1' }], error: null });
  results.push({ data: [{ id: 'run-1', insight_id: 'ins-1', group_id: null, status: 'completed', pr_url: 'https://github.com/a/b/pull/1', pr_number: 1, closed_at: null, created_at: REPORTED_AT }], error: null });
  results.push(anchor);
}

const anchorCall = () =>
  calls.find((c) => c.table === 'messages' && c.methods.some((m) => m[0] === 'in' && m[1] === 'conversation_id'));
const webCalls = () =>
  calls.filter((c) => c.table === 'responses' && c.methods.some((m) => m[0] === 'eq' && m[1] === 'conversations.source'));
const repoCall = () => calls.find((c) => c.table === 'bots');

beforeEach(() => {
  vi.clearAllMocks();
  results.length = 0;
  calls.length = 0;
  resolveOwnedBots.mockResolvedValue({ ok: true, botIds: [BOT] });
  from.mockImplementation((table: string) => {
    const result = results.shift() ?? { data: [], count: 0, error: null };
    const call = { table, methods: [] as [string, ...unknown[]][] };
    calls.push(call);
    const query = { then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) } as Record<string, unknown>;
    for (const method of ['select', 'in', 'eq', 'not', 'is', 'lte', 'lt', 'gte', 'order', 'limit']) {
      query[method] = (...args: unknown[]) => { call.methods.push([method, ...args]); return query; };
    }
    return query;
  });
});

describe('루프 시간 표본 조회', () => {
  it('소유 봇과 되돌림이 간 대화로 좁히고, 이른 것부터 상한을 걸어 읽는다', async () => {
    pushLeadingCounts();
    pushLoopFixtures();
    const data = await (await GET()).json();

    expect(data.stats.loopTime).toEqual({ state: 'ok', sampleSize: 1, averageMs: TWO_DAYS });
    const anchor = anchorCall();
    expect(anchor).toBeDefined();
    expect(anchor!.methods).toContainEqual(['in', 'bot_id', [BOT]]);
    expect(anchor!.methods).toContainEqual(['in', 'conversation_id', ['conv-1']]);
    // 정렬이 없으면 상한에서 «어느» 행이 잘릴지 정해지지 않는다 — 첫 제보가 빠지면 평균이 작아진다.
    expect(anchor!.methods).toContainEqual(['order', 'detected_at', { ascending: true }]);
    expect(anchor!.methods.some((m) => m[0] === 'limit' && typeof m[1] === 'number' && m[1] > 0)).toBe(true);
  });

  it('상한에 닿으면 평균을 내지 않고 「집계 못 함」으로 말한다', async () => {
    pushLeadingCounts();
    const limitRow = { id: 'msg-1', conversation_id: 'conv-1', detected_at: REPORTED_AT };
    // 상한을 모르는 채로도 깨지지 않도록, 조회에 실린 limit 값만큼 돌려준다.
    pushLoopFixtures({ data: [], error: null });
    const first = await (await GET()).json();
    const limit = Number(anchorCall()!.methods.find((m) => m[0] === 'limit')![1]);

    results.length = 0;
    calls.length = 0;
    pushLeadingCounts();
    pushLoopFixtures({ data: Array.from({ length: limit }, () => limitRow), error: null });
    const data = await (await GET()).json();

    expect(first.stats.loopTime.state).toBe('empty');
    expect(data.stats.loopTime).toEqual({ state: 'error', sampleSize: 0, averageMs: null });
  });

  it('표본 조회가 실패해도 대시보드는 살아 있고, 0 대신 「집계 못 함」을 말한다', async () => {
    pushLeadingCounts();
    pushLoopFixtures({ data: null, error: { message: 'timeout' } });
    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.stats.loopTime.state).toBe('error');
  });

  it('되돌림이 하나도 안 나갔으면 표본 조회를 아예 하지 않는다', async () => {
    pushLeadingCounts();
    results.push({ data: [], error: null }, { data: [], error: null }, { data: [], error: null }, { data: [], error: null });
    const data = await (await GET()).json();

    expect(anchorCall()).toBeUndefined();
    expect(data.stats.loopTime.state).toBe('empty');
  });
});

describe('되돌림 확인 집계', () => {
  it('분자와 분모가 같은 모집단(web 대화)을 보고, 소유 봇으로 좁혀져 있다', async () => {
    pushLeadingCounts();
    pushLoopFixtures();
    results.push({ count: 3, error: null }, { count: 1, error: null }, { count: 6, error: null });
    results.push({ data: [{ id: BOT, github_repo_url: 'https://github.com/a/b' }], error: null });
    const data = await (await GET()).json();

    expect(data.stats.confirmation).toEqual({ state: 'ok', fixed: 3, notFixed: 1, delivered: 6 });
    const web = webCalls();
    expect(web).toHaveLength(3);
    for (const call of web) {
      expect(call.methods).toContainEqual(['in', 'bot_id', [BOT]]);
      expect(call.methods).toContainEqual(['eq', 'response_type', 'loop_closed']);
      expect(call.methods).toContainEqual(['eq', 'conversations.source', 'web']);
    }
    // 분모는 「전달된」 것만 센다
    expect(web[2].methods).toContainEqual(['not', 'delivered_at', 'is', null]);
  });

  it('집계가 실패하면 0 이 아니라 「집계 못 함」이다', async () => {
    pushLeadingCounts();
    pushLoopFixtures();
    results.push({ count: null, error: { message: 'timeout' } }, { count: 0, error: null }, { count: 0, error: null });
    const data = await (await GET()).json();

    expect(data.stats.confirmation.state).toBe('error');
  });
});

describe('체크리스트 ③ 재료', () => {
  it('레포가 지정된 봇의 id 만 내려보낸다 — 주소도 토큰도 응답에 없다', async () => {
    pushLeadingCounts();
    pushLoopFixtures();
    results.push({ count: 0, error: null }, { count: 0, error: null }, { count: 0, error: null });
    results.push({
      data: [
        { id: 'bot-with-repo', github_repo_url: 'https://github.com/a/b' },
        { id: 'bot-without-repo', github_repo_url: null },
      ],
      error: null,
    });
    const res = await GET();
    const body = await res.text();

    expect(JSON.parse(body).stats.githubReadyBotIds).toEqual(['bot-with-repo']);
    expect(body).not.toContain('github.com/a/b');
    expect(repoCall()!.methods).toContainEqual(['in', 'id', [BOT]]);
    // 토큰·설치 컬럼은 애초에 읽지 않는다
    const selected = String(repoCall()!.methods.find((m) => m[0] === 'select')![1]);
    expect(selected).toBe('id, github_repo_url');
  });
});
