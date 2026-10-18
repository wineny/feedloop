import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  AUTO_PR_MIN_DISTINCT_CONVERSATIONS,
  autoPrSkipReason,
  pickGroupForAutoPr,
  type AutoPrCandidate,
} from '@/lib/auto-dev/auto-pr';

// ── 크론 라우트용 모킹 ──────────────────────────────
// pickGroupForAutoPr 는 «진짜» 를 쓴다(아래 순수 함수 테스트가 그걸 검증한다).
// 실제 PR 을 만드는 runAutoPrForBot 만 가짜로 바꾼다.

interface BotQuery {
  filters: Array<[string, unknown, unknown]>;
}

let botQueries: BotQuery[] = [];
let botRows: Array<{ id: string }> = [];

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: () => ({
      select: () => {
        const rec: BotQuery = { filters: [] };
        botQueries.push(rec);
        const self: Record<string, unknown> = {};
        for (const m of ['eq', 'not', 'is', 'order', 'limit']) {
          self[m] = (a?: unknown, b?: unknown) => {
            rec.filters.push([m, a, b]);
            return self;
          };
        }
        self.then = (resolve: (v: unknown) => void) => resolve({ data: botRows, error: null });
        return self;
      },
    }),
  }),
}));

// vi.mock 팩토리는 파일 맨 위로 끌어올려진다 — 평범한 const 로 두면 초기화 전에 읽힌다.
const { runAutoPrForBotMock } = vi.hoisted(() => ({
  runAutoPrForBotMock: vi.fn(async (botId: string) => ({ botId, prUrl: null })),
}));

vi.mock('@/lib/auto-dev/auto-pr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auto-dev/auto-pr')>();
  return { ...actual, runAutoPrForBot: runAutoPrForBotMock };
});

/**
 * 기본값은 «통과하는» 묶음이다 — 서로 다른 대화 2개(익명 게이트를 지나는 최소값).
 * 익명 게이트 자체는 아래 별도 describe 가 잰다.
 */
function c(partial: Partial<AutoPrCandidate> & { id: string }): AutoPrCandidate {
  return {
    status: 'open',
    category: 'bug',
    insightCount: 1,
    hasRun: false,
    distinctConversations: 2,
    hasReachableContact: false,
    ...partial,
  };
}

describe('pickGroupForAutoPr — 자동 모드는 봇당 하루 묶음 하나', () => {
  it('인사이트가 가장 많은 open 묶음을 고른다', () => {
    const picked = pickGroupForAutoPr([
      c({ id: 'a', insightCount: 2 }),
      c({ id: 'b', insightCount: 5 }),
      c({ id: 'c', insightCount: 3 }),
    ]);
    expect(picked?.id).toBe('b');
  });

  it('핵심 흐름 차단과 사람 수를 반영한 점수로 고른다', () => {
    expect(pickGroupForAutoPr([
      c({ id: 'many', insightCount: 10, personCount: 2 }),
      c({ id: 'core', insightCount: 1, personCount: 1, impactCore: true }),
    ])?.id).toBe('core');
    expect(pickGroupForAutoPr([
      c({ id: 'repeat', insightCount: 5, personCount: 1 }),
      c({ id: 'people', insightCount: 3, personCount: 3 }),
    ])?.id).toBe('people');
  });

  it('core여도 익명 1인 게이트는 통과하지 못한다', () => {
    expect(pickGroupForAutoPr([c({ id: 'anon-core', impactCore: true, distinctConversations: 1 })])).toBeNull();
  });

  it('동점이면 앞선 것(최신순으로 받은 첫 번째)을 고른다', () => {
    const picked = pickGroupForAutoPr([
      c({ id: 'newer', insightCount: 3 }),
      c({ id: 'older', insightCount: 3 }),
    ]);
    expect(picked?.id).toBe('newer');
  });

  it('open 이 아닌 묶음은 크기와 무관하게 제외한다', () => {
    const picked = pickGroupForAutoPr([
      c({ id: 'pr', status: 'pr_created', insightCount: 9 }),
      c({ id: 'merged', status: 'merged', insightCount: 9 }),
      c({ id: 'dismissed', status: 'dismissed', insightCount: 9 }),
      c({ id: 'open', insightCount: 1 }),
    ]);
    expect(picked?.id).toBe('open');
  });

  it('run 이 있었던 묶음은 실패했더라도 다시 돌리지 않는다', () => {
    // "고칠 파일이 없다"로 실패한 묶음을 매일 재시도하면 같은 실패를 반복한다.
    const picked = pickGroupForAutoPr([
      c({ id: 'failed-before', insightCount: 9, hasRun: true }),
      c({ id: 'fresh', insightCount: 2 }),
    ]);
    expect(picked?.id).toBe('fresh');
  });

  it('코드로 고칠 수 없는 분류는 크기와 무관하게 제외한다', () => {
    // 자동 모드는 사람이 안 보고 있다. 기능 요청에 PR 을 열면 대개 쓸모없는 변경이 나온다.
    const picked = pickGroupForAutoPr([
      c({ id: 'feature', category: 'feature_request', insightCount: 9 }),
      c({ id: 'praise', category: 'praise', insightCount: 8 }),
      c({ id: 'cs', category: 'cs', insightCount: 7 }),
      c({ id: 'other', category: 'other', insightCount: 6 }),
      c({ id: 'bug', category: 'bug', insightCount: 1 }),
    ]);
    expect(picked?.id).toBe('bug');
  });

  it('ux 는 코드로 고쳐지는 경우가 많아 대상에 넣는다', () => {
    const picked = pickGroupForAutoPr([c({ id: 'ux', category: 'ux', insightCount: 2 })]);
    expect(picked?.id).toBe('ux');
  });

  it('open 묶음이 기능 요청 하나뿐이면 아무것도 고르지 않는다', () => {
    // 리허설에서 후속 문의 묶음에 PR 이 열려 무의미한 PR #4 가 생겼던 사고를 막는다.
    expect(
      pickGroupForAutoPr([c({ id: 'only-feature', category: 'feature_request', insightCount: 5 })]),
    ).toBeNull();
  });

  it('고를 게 없으면 null — 크론은 그 봇을 조용히 건너뛴다', () => {
    expect(pickGroupForAutoPr([])).toBeNull();
    expect(pickGroupForAutoPr([c({ id: 'x', hasRun: true })])).toBeNull();
  });
});

// ── I-34 ③ · 심사 §7 T11 — 익명 위젯 한 번이 PR 이 되지 않는다 ──────────
//
// 위젯 POST 는 무인증이다. 아무나 남의 사이트 봇에 `bug` 로 읽힐 문장을 넣을 수 있고,
// 그게 묶이면 크론이 사람 없이 남의 레포에 PR 을 연다. 채널톡 U4 의 대칭 게이트다.
describe('자동 PR — 익명 1인 묶음은 집지 않는다', () => {
  it('연락처 없는 1인 묶음은 크기와 무관하게 건너뛴다', () => {
    expect(
      pickGroupForAutoPr([c({ id: 'anon', insightCount: 9, distinctConversations: 1, hasReachableContact: false })]),
    ).toBeNull();
  });

  it('한 사람이 같은 말을 여러 번 해도 1인이다 — insightCount 로는 못 막는다', () => {
    // 이 케이스가 이 게이트의 존재 이유다. insightCount 9 는 「많은 제보」로 보이지만
    // 서로 다른 대화는 하나뿐이라 실제로는 한 사람이 아홉 번 말한 것이다.
    const picked = pickGroupForAutoPr([
      c({ id: 'loud-anon', insightCount: 9, distinctConversations: 1, hasReachableContact: false }),
      c({ id: 'two-people', insightCount: 2, distinctConversations: 2 }),
    ]);
    expect(picked?.id).toBe('two-people');
  });

  it('연락처가 있으면 1인 묶음도 대상이다 — 익명이 아니기 때문이다', () => {
    const picked = pickGroupForAutoPr([
      c({ id: 'named', insightCount: 1, distinctConversations: 1, hasReachableContact: true }),
    ]);
    expect(picked?.id).toBe('named');
  });

  it('서로 다른 대화 2개 이상이면 연락처가 없어도 대상이다', () => {
    const picked = pickGroupForAutoPr([
      c({ id: 'crowd', insightCount: 2, distinctConversations: AUTO_PR_MIN_DISTINCT_CONVERSATIONS }),
    ]);
    expect(picked?.id).toBe('crowd');
  });

  it('익명이라 막힌 것과 애초에 고를 게 없던 것을 다른 사유로 남긴다', () => {
    // 로그에서 이 둘이 같은 문자열이면 「누가 익명으로 PR 을 만들려 했다」가 안 보인다.
    expect(autoPrSkipReason([])).toBe('no_open_group');
    expect(
      autoPrSkipReason([c({ id: 'anon', distinctConversations: 1, hasReachableContact: false })]),
    ).toBe('anonymous_only');
    expect(autoPrSkipReason([c({ id: 'ran-before', hasRun: true })])).toBe('no_eligible_group');
    expect(autoPrSkipReason([c({ id: 'feature', category: 'feature_request' })])).toBe(
      'no_eligible_group',
    );
  });

  it('익명 묶음이라도 다른 이유로 이미 걸러졌으면 익명 탓으로 적지 않는다', () => {
    // 이미 run 이 돌았던 묶음은 익명 여부와 무관하게 제외 대상이다.
    expect(
      autoPrSkipReason([c({ id: 'x', hasRun: true, distinctConversations: 1 })]),
    ).toBe('no_eligible_group');
  });

  it('사람이 누르는 [PR 만들기] 는 이 게이트를 지나지 않는다', () => {
    // 승인 경로(/api/auto-dev)는 화면 앞에 사람이 있다. 이 게이트는 «사람이 없는» 크론만 조인다.
    // 그 경로가 나중에 auto-pr 의 선별기를 가져다 쓰면 운영자가 자기 묶음에 PR 을 못 만들게 된다.
    const manual = readFileSync(new URL('../src/app/api/auto-dev/route.ts', import.meta.url), 'utf8');
    expect(manual).not.toMatch(/auto-dev\/auto-pr/);
    expect(manual).not.toMatch(/pickGroupForAutoPr|AUTO_PR_MIN_DISTINCT_CONVERSATIONS/);
  });
});

describe('자동 PR 크론 — 채널톡이 붙은 봇은 집지 않는다', () => {
  let GET: typeof import('@/app/api/cron/auto-pr/route').GET;

  function request(auth: string | null) {
    return {
      headers: { get: (k: string) => (k === 'authorization' ? auth : null) },
    } as unknown as import('next/server').NextRequest;
  }

  beforeEach(async () => {
    vi.resetModules();
    botQueries = [];
    botRows = [];
    runAutoPrForBotMock.mockClear();
    process.env.CRON_SECRET = 'cron-secret';
    ({ GET } = await import('@/app/api/cron/auto-pr/route'));
  });

  it('봇 조회에서 채널톡 자격증명이 있는 봇을 제외한다', async () => {
    await GET(request('Bearer cron-secret'));

    expect(botQueries).toHaveLength(1);
    // U4 — PATCH 게이트가 pr_mode 를 approve 로 묶지만 그건 read-then-write 다.
    // 조건이 쿼리에 있어야 어떤 쓰기 경로로 pr_mode 가 바뀌든 크론이 안 집는다.
    expect(botQueries[0].filters).toContainEqual(['is', 'channel_access_key_encrypted', null]);
  });

  it('자동 모드·레포 조건은 그대로 둔다 — 무회귀', async () => {
    await GET(request('Bearer cron-secret'));

    const f = botQueries[0].filters;
    expect(f).toContainEqual(['eq', 'pr_mode', 'auto']);
    expect(f).toContainEqual(['not', 'github_repo_url', 'is']);
  });

  it('인증이 없으면 봇을 읽지도 않는다', async () => {
    const res = await GET(request(null));

    expect(res.status).toBe(401);
    expect(botQueries).toHaveLength(0);
    expect(runAutoPrForBotMock).not.toHaveBeenCalled();
  });

  it('걸러진 목록에 남은 봇만 돌린다', async () => {
    botRows = [{ id: 'bot-1' }, { id: 'bot-2' }];

    const res = await GET(request('Bearer cron-secret'));

    expect(await res.json()).toMatchObject({ bots: 2 });
    expect(runAutoPrForBotMock.mock.calls.map((c) => c[0])).toEqual(['bot-1', 'bot-2']);
  });
});
