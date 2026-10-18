import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

// ── 위젯 봇별 시간당 상한 (심사 §7 T10) ──────────────────────
//
// 방문자 20/분·IP 60/분 은 «한 명» 을 재는 자다. visitorId 는 위젯이 스스로 만드는 값이고
// IP 계수는 인메모리라 인스턴스가 갈리면 0 부터 다시 센다 — 그래서 익명 POST 로 플랫폼
// 무료분(하루 100건)을 분 단위로 태울 수 있었다. 이 파일은 그 경로가 다시 열리는 것을 막는다.

const h = vi.hoisted(() => ({
  /** 이 호출에서 실제로 DB 에 걸린 필터. 쿼리 모양(어느 창을 보는가)까지 본다. */
  queries: [] as Array<{ table: string; filters: Array<{ op: string; args: unknown[] }> }>,
  /**
   * `messages` 행. 모의가 필터를 «실제로 적용해» 센다 — 필터 문자열의 존재만 확인하면
   * 조건이 틀린 쿼리(예: 카카오까지 세는 쿼리)도 테스트를 통과한다.
   */
  rows: [] as Array<Record<string, unknown>>,
  error: null as null | { code: string; message: string },
}));

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from(table: string) {
      const filters: Array<{ op: string; args: unknown[] }> = [];
      h.queries.push({ table, filters });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {};
      for (const op of ['select', 'eq', 'gte', 'in', 'is', 'not']) {
        chain[op] = (...args: unknown[]) => {
          if (op !== 'select') filters.push({ op, args });
          return chain;
        };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chain.then = (resolve: any, reject: any) => {
        if (h.error) return Promise.resolve({ count: null, error: h.error }).then(resolve, reject);
        const count = h.rows.filter((row) =>
          filters.every(({ op, args }) => {
            const value = row[args[0] as string];
            if (op === 'eq') return value === args[1];
            if (op === 'gte') return String(value) >= String(args[1]);
            return true;
          }),
        ).length;
        return Promise.resolve({ count, error: null }).then(resolve, reject);
      };
      return chain;
    },
  }),
}));

import { checkReadRate, checkWriteRate, WIDGET_BOT_HOURLY_LIMIT } from '@/lib/widget/http';
import { DEFAULT_LIMITS } from '@/lib/llm/limits';

const BOT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VISITOR = '22222222-2222-4222-8222-222222222222';

/**
 * IP 계수는 모듈 수준 맵이라 테스트끼리 샌다(같은 IP 로 61번 부르면 IP 상한이 먼저 걸려
 * 봇 상한을 못 잰다). 테스트마다 다른 IP 를 준다.
 */
let ipSeq = 0;
function request() {
  ipSeq += 1;
  const ip = `203.0.113.${ipSeq % 250}`;
  return {
    headers: { get: (k: string) => (k === 'x-forwarded-for' ? ip : null) },
  } as unknown as import('next/server').NextRequest;
}

async function body(res: Response | null) {
  return res ? ((await res.json()) as { error?: string }) : null;
}

/** 방금 들어온 위젯 발화 n건. 방문자는 «다른 사람»이라 방문자 상한과 섞이지 않는다. */
function widgetMessages(botId: string, n: number, over: Record<string, unknown> = {}) {
  return Array.from({ length: n }, (_, i) => ({
    bot_id: botId,
    source: 'web',
    external_user_id: `other-${i}`,
    detected_at: new Date().toISOString(),
    ...over,
  }));
}

beforeEach(() => {
  h.queries = [];
  h.rows = [];
  h.error = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('봇별 시간당 상한 — 값과 근거', () => {
  it('플랫폼 무료분(하루 100건)보다 낮다 — 하루치를 한 시간에 태우는 경로를 막는다', () => {
    // 이 부등식이 뒤집히면 상한이 상한이 아니게 된다. 값을 올릴 때 같이 보라고 남긴다.
    // (소진까지 최소 두 시간을 벌어줄 뿐, 「항상 이게 먼저 걸린다」는 뜻은 아니다)
    expect(WIDGET_BOT_HOURLY_LIMIT).toBeLessThan(DEFAULT_LIMITS.noKey);
  });
});

describe('봇별 시간당 상한 — 통과와 차단', () => {
  it('상한 이하면 통과한다', async () => {
    h.rows = widgetMessages(BOT_A, WIDGET_BOT_HOURLY_LIMIT - 1);

    expect(await checkWriteRate(request(), BOT_A, VISITOR)).toBeNull();
  });

  it('상한에 닿으면 429 로 막는다', async () => {
    h.rows = widgetMessages(BOT_A, WIDGET_BOT_HOURLY_LIMIT);

    const res = await checkWriteRate(request(), BOT_A, VISITOR);

    expect(res?.status).toBe(429);
    expect((await body(res))?.error).toContain('문의가 몰려');
  });

  it('봇이 다르면 독립이다 — 한 봇이 막혀도 옆 봇은 통과한다', async () => {
    h.rows = widgetMessages(BOT_A, WIDGET_BOT_HOURLY_LIMIT).concat(widgetMessages(BOT_B, 1));

    expect((await checkWriteRate(request(), BOT_A, VISITOR))?.status).toBe(429);
    expect(await checkWriteRate(request(), BOT_B, VISITOR)).toBeNull();
  });

  it('방문자 상한이 먼저 걸리면 기존 문구가 그대로 나간다 — 무회귀', async () => {
    // 한 방문자가 분당 20건을 넘긴 상태. 봇 상한에도 동시에 걸려 있다.
    h.rows = widgetMessages(BOT_A, WIDGET_BOT_HOURLY_LIMIT, { external_user_id: VISITOR });

    const res = await checkWriteRate(request(), BOT_A, VISITOR);

    expect(res?.status).toBe(429);
    expect((await body(res))?.error).toContain('너무 빨리');
  });

  it('계수가 실패하면 막지 않는다 — 뒤에 일일 예산이 fail-closed 로 버틴다', async () => {
    h.error = { code: '42P01', message: 'boom' };

    expect(await checkWriteRate(request(), BOT_A, VISITOR)).toBeNull();
  });
});

describe('봇별 시간당 상한 — 무엇을 세는가', () => {
  it('카카오·채널톡 발화는 세지 않는다 — 다른 입구가 위젯을 막으면 안 된다', async () => {
    // 필터 «문자열» 이 아니라 계수 결과로 잰다. 조건이 틀린 쿼리는 여기서 빨개진다.
    h.rows = widgetMessages(BOT_A, WIDGET_BOT_HOURLY_LIMIT * 2, { source: 'kakao' })
      .concat(widgetMessages(BOT_A, WIDGET_BOT_HOURLY_LIMIT * 2, { source: 'channel' }))
      .concat(widgetMessages(BOT_A, 1));

    expect(await checkWriteRate(request(), BOT_A, VISITOR)).toBeNull();
  });

  it('대화 임베드가 아니라 messages 컬럼을 본다 — 스키마 캐시가 어긋나도 안 꺼진다', async () => {
    await checkWriteRate(request(), BOT_A, VISITOR);

    const botQuery = h.queries.find((q) => q.filters.some((f) => f.args[0] === 'source'));
    expect(botQuery?.table).toBe('messages');
    expect(botQuery?.filters).toContainEqual({ op: 'eq', args: ['source', 'web'] });
    expect(h.queries.some((q) => q.filters.some((f) => String(f.args[0]).includes('conversations')))).toBe(false);
  });
});

describe('봇별 시간당 상한 — 시간 창', () => {
  it('정확히 1시간 창을 본다', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T12:00:00.000Z'));

    await checkWriteRate(request(), BOT_A, VISITOR);

    // 봇 쿼리는 방문자 쿼리와 달리 `external_user_id` 를 안 건다.
    const botQuery = h.queries.find((q) => !q.filters.some((f) => f.args[0] === 'external_user_id'));
    expect(botQuery?.table).toBe('messages');
    expect(botQuery?.filters).toContainEqual({ op: 'gte', args: ['detected_at', '2026-09-17T11:00:00.000Z'] });
  });

  it('창 밖의 예전 발화는 세지 않는다', async () => {
    const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
    h.rows = widgetMessages(BOT_A, WIDGET_BOT_HOURLY_LIMIT * 3, { detected_at: old });

    expect(await checkWriteRate(request(), BOT_A, VISITOR)).toBeNull();
  });
});

describe('IP 상한 — 읽기 경로', () => {
  it('checkReadRate 는 IP 상한만 본다 — 봇이 막혀 있어도 읽기는 통과한다', async () => {
    h.rows = widgetMessages(BOT_A, WIDGET_BOT_HOURLY_LIMIT * 5);

    expect(checkReadRate(request())).toBeNull();
    // DB 를 아예 안 본다 — 읽기 경로엔 저장되는 발화가 없어 셀 것이 없다.
    expect(h.queries).toHaveLength(0);
  });

  it('같은 IP 가 분당 60회를 넘기면 읽기도 막는다', async () => {
    const req = request();
    for (let i = 0; i < 60; i += 1) checkReadRate(req);

    expect(checkReadRate(req)?.status).toBe(429);
  });
});

describe('봇별 시간당 상한 — 무인증 쓰기 라우트 네 곳에 다 걸린다', () => {
  // 상한은 헬퍼 안에 있으므로, 라우트 하나가 헬퍼를 안 부르면 그 라우트만 조용히 열린다.
  // 그 회귀를 잡는 유일한 자리라 소스를 직접 읽는다.
  it.each(['escalate', 'contact', 'confirm'])('%s 라우트가 checkWriteRate 를 지난다', (route) => {
    const src = readFileSync(
      new URL(`../src/app/api/widget/[botId]/${route}/route.ts`, import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/checkWriteRate\(/);
  });

  it('messages 라우트는 어느 상한인지 보는 판정기를 지난다', () => {
    // 이 라우트만 다르다 — 봇 상한이면 저장하고 LLM 만 건너뛴다(reply-limit.test.ts 가 잰다).
    const src = readFileSync(
      new URL('../src/app/api/widget/[botId]/messages/route.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/checkWidgetWriteRate\(/);
  });

  it('confirm 라우트는 GET 도 읽기 상한을 지난다', () => {
    const src = readFileSync(
      new URL('../src/app/api/widget/[botId]/confirm/route.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/checkReadRate\(/);
  });
});
