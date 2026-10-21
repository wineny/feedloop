import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Supabase 모킹 ───────────────────────────────────
// getTimeline 은 messages / responses 두 테이블을 각각 읽어 합친다.
// 테이블 이름으로 갈라 서로 다른 결과를 돌려준다.

let messageRows: unknown[] = [];
let responseRows: unknown[] = [];
/** 어느 테이블에 어떤 필터가 걸렸는지. 가짜 db 는 필터를 «적용»하지 않으므로 이걸로 본다. */
let chainCalls: { table: string; method: string; args: unknown[] }[] = [];

function chainFor(table: string) {
  const chain: Record<string, unknown> = {};
  for (const m of ['eq', 'gt', 'lte', 'not', 'order', 'limit']) {
    chain[m] = vi.fn((...args: unknown[]) => {
      chainCalls.push({ table, method: m, args });
      return chain;
    });
  }
  // order().limit() 이 최종적으로 await 되므로 thenable 로 만든다
  chain.then = (resolve: (v: unknown) => void) =>
    resolve({ data: table === 'messages' ? messageRows : responseRows, error: null });
  return chain;
}

const fromMock = vi.fn((table: string) => ({
  select: vi.fn(() => chainFor(table)),
}));

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({ from: fromMock }),
}));

describe('isUuid', () => {
  let isUuid: typeof import('@/lib/widget/http').isUuid;

  beforeEach(async () => {
    vi.resetModules();
    ({ isUuid } = await import('@/lib/widget/http'));
  });

  it('정상 UUID 를 통과시킨다', () => {
    expect(isUuid('35028c5f-bfce-4761-980d-ad6874a9b6ea')).toBe(true);
    expect(isUuid('35028C5F-BFCE-4761-980D-AD6874A9B6EA')).toBe(true);
  });

  it('위젯이 보내는 값은 전부 남이 만든 문자열이다 — 형식이 아니면 막는다', () => {
    for (const bad of [
      'not-a-uuid',
      '',
      '35028c5f-bfce-4761-980d',                        // 짧음
      '35028c5f-bfce-4761-980d-ad6874a9b6ea-extra',     // 김
      "35028c5f-bfce-4761-980d-ad6874a9b6ea'; drop--",  // 주입 시도
      null,
      undefined,
      123,
      {},
    ]) {
      expect(isUuid(bad)).toBe(false);
    }
  });
});

describe('getTimeline', () => {
  let getTimeline: typeof import('@/lib/bot/conversations').getTimeline;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    messageRows = [];
    responseRows = [];
    ({ getTimeline } = await import('@/lib/bot/conversations'));
  });

  it('유저 메시지와 우리 응답을 시각순으로 합친다', async () => {
    messageRows = [
      { id: 'm1', body: '쿠폰이 안 눌려요', detected_at: '2026-09-06T10:00:00Z' },
      { id: 'm2', body: '아직인가요?', detected_at: '2026-09-06T10:05:00Z' },
    ];
    responseRows = [
      {
        id: 'r1',
        response_type: 'ai',
        response_body: '확인 중이에요',
        sent_at: '2026-09-06T10:01:00Z',
        delivered_at: '2026-09-06T10:01:00Z',
      },
    ];

    const items = await getTimeline('conv-1');

    expect(items.map((i) => i.id)).toEqual(['m1', 'r1', 'm2']);
    expect(items.map((i) => i.kind)).toEqual(['user', 'ai', 'user']);
  });

  it('response_type 을 말풍선 5종으로 접는다', async () => {
    responseRows = [
      { id: 'r1', response_type: 'ai', response_body: 'a', sent_at: '2026-09-06T10:00:00Z', delivered_at: 'x' },
      { id: 'r2', response_type: 'operator', response_body: 'b', sent_at: '2026-09-06T10:01:00Z', delivered_at: 'x' },
      { id: 'r3', response_type: 'loop_closed', response_body: 'c', sent_at: '2026-09-06T10:02:00Z', delivered_at: 'x' },
      // 텔레그램 시절 값들 — AI 말풍선으로 접힌다
      { id: 'r4', response_type: 'kakao', response_body: 'd', sent_at: '2026-09-06T10:03:00Z', delivered_at: 'x' },
      { id: 'r5', response_type: 'mention', response_body: 'e', sent_at: '2026-09-06T10:04:00Z', delivered_at: 'x' },
      // 「담당자에게 물어보기」 기록 — 되돌림 카드(system)가 아니라 가운데 안내 칩(notice)
      { id: 'r6', response_type: 'system', response_body: 'f', sent_at: '2026-09-06T10:05:00Z', delivered_at: 'x' },
      // PayPal 3단계 — 서버 고정 문장은 결제 카드(payment), 결제 에이전트의 말은 AI 말풍선
      { id: 'r7', response_type: 'payment', response_body: 'g', sent_at: '2026-09-06T10:06:00Z', delivered_at: 'x' },
      { id: 'r8', response_type: 'payment_agent', response_body: 'h', sent_at: '2026-09-06T10:07:00Z', delivered_at: 'x' },
    ];

    const items = await getTimeline('conv-1');

    expect(items.map((i) => i.kind)).toEqual(['ai', 'operator', 'system', 'ai', 'ai', 'notice', 'payment', 'ai']);
  });

  it('아직 전달 안 된 응답은 타임라인에 넣지 않는다', async () => {
    // delivered_at 이 null 이면 카카오 대기열에 걸려 있는 것이다.
    // 유저가 아직 못 받은 말을 화면에 먼저 띄우면 안 된다.
    responseRows = [
      { id: 'sent', response_type: 'ai', response_body: '보냄', sent_at: '2026-09-06T10:00:00Z', delivered_at: '2026-09-06T10:00:00Z' },
      { id: 'queued', response_type: 'operator', response_body: '대기중', sent_at: '2026-09-06T10:01:00Z', delivered_at: null },
    ];

    const items = await getTimeline('conv-1');

    expect(items.map((i) => i.id)).toEqual(['sent']);
  });

  it('빈 대화는 빈 배열이다', async () => {
    await expect(getTimeline('conv-empty')).resolves.toEqual([]);
  });
});

describe('getRecentTurns', () => {
  let getRecentTurns: typeof import('@/lib/bot/conversations').getRecentTurns;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    messageRows = [];
    responseRows = [];
    chainCalls = [];
    ({ getRecentTurns } = await import('@/lib/bot/conversations'));
  });

  // 왜 getTimeline 을 못 쓰나 — 그쪽은 «오름차순 200건»이라 턴이 200 을 넘는 대화에서
  // 돌아오는 것이 가장 «오래된» 200턴이다. 뒤에서 8개를 잘라도 옛날 말이 실린다.
  // 여기서는 각 테이블을 내림차순으로 읽고(가짜 db 는 준 순서를 그대로 돌려준다)
  // 합친 뒤 오름차순으로 되돌린다.

  it('내림차순으로 읽어 오름차순으로 돌려준다', async () => {
    messageRows = [
      { id: 'm3', body: '셋', detected_at: '2026-09-13T10:04:00Z' },
      { id: 'm2', body: '둘', detected_at: '2026-09-13T10:02:00Z' },
      { id: 'm1', body: '하나', detected_at: '2026-09-13T10:00:00Z' },
    ];
    responseRows = [
      { id: 'r1', response_type: 'ai', response_body: '답', sent_at: '2026-09-13T10:01:00Z', delivered_at: 'x' },
    ];

    const items = await getRecentTurns('conv-1', 10);

    expect(items.map((i) => i.id)).toEqual(['m1', 'r1', 'm2', 'm3']);
    expect(items.map((i) => i.kind)).toEqual(['user', 'ai', 'user', 'user']);
  });

  it('두 테이블을 각각 limit 개씩 읽으므로 합치면 넘친다 — 마지막 limit 개만 남긴다', async () => {
    messageRows = [
      { id: 'm4', body: '4', detected_at: '2026-09-13T10:08:00Z' },
      { id: 'm3', body: '3', detected_at: '2026-09-13T10:06:00Z' },
    ];
    responseRows = [
      { id: 'r2', response_type: 'ai', response_body: '2', sent_at: '2026-09-13T10:04:00Z', delivered_at: 'x' },
      { id: 'r1', response_type: 'ai', response_body: '1', sent_at: '2026-09-13T10:02:00Z', delivered_at: 'x' },
    ];

    const items = await getRecentTurns('conv-1', 2);

    expect(items.map((i) => i.id)).toEqual(['m3', 'm4']);
  });

  it('미전달 응답은 쿼리에서 뺀다 — 유저가 아직 못 본 말을 「최근 대화」로 보여주면 모델이 한 말로 여긴다', async () => {
    await getRecentTurns('conv-1', 5);

    // 가짜 db 는 필터를 «적용»하지 않으므로 행이 아니라 쿼리를 본다.
    // 내림차순으로 뒤에서 N건을 읽는 구조라, 대기열 응답이 그 N건을 먹으면
    // 진짜 최근 턴이 조용히 밀려난다 — 걸러내기는 코드가 아니라 쿼리에 있어야 한다.
    expect(chainCalls).toContainEqual({
      table: 'responses',
      method: 'not',
      args: ['delivered_at', 'is', null],
    });
    expect(chainCalls.some((c) => c.table === 'messages' && c.method === 'not')).toBe(false);
  });

  it('두 테이블 모두 내림차순으로 읽는다 — 오름차순이면 긴 대화에서 옛날 턴이 실린다', async () => {
    await getRecentTurns('conv-1', 5);

    for (const table of ['messages', 'responses']) {
      const order = chainCalls.find((c) => c.table === table && c.method === 'order');
      expect(order?.args[1]).toEqual({ ascending: false });
      expect(chainCalls).toContainEqual({ table, method: 'limit', args: [5] });
    }
  });

  it('recovery cutoff excludes later turns in both queries', async () => {
    await getRecentTurns('c1', 8, '2026-09-13T00:00:00.000Z');
    expect(chainCalls.filter((c) => c.method === 'lte')).toEqual([
      { table: 'messages', method: 'lte', args: ['detected_at', '2026-09-13T00:00:00.000Z'] },
      { table: 'responses', method: 'lte', args: ['sent_at', '2026-09-13T00:00:00.000Z'] },
    ]);
  });

  it('빈 대화는 빈 배열이다', async () => {
    await expect(getRecentTurns('conv-empty', 8)).resolves.toEqual([]);
  });
});

describe('분류 힌트', () => {
  let http: typeof import('@/lib/widget/http');

  beforeEach(async () => {
    vi.resetModules();
    http = await import('@/lib/widget/http');
  });

  it('세 힌트만 통과시킨다 — 위젯이 보내는 값은 남이 만든 문자열이다', () => {
    expect(http.isWidgetHint('bug')).toBe(true);
    expect(http.isWidgetHint('feature')).toBe(true);
    expect(http.isWidgetHint('question')).toBe(true);
    for (const bad of ['praise', 'BUG', '', null, undefined, 1, {}, 'bug; drop--']) {
      expect(http.isWidgetHint(bad)).toBe(false);
    }
  });

  it('힌트는 insights.category 값으로 번역돼 프롬프트에 붙는다', () => {
    expect(http.hintLine('bug')).toContain('"bug"');
    expect(http.hintLine('feature')).toContain('"feature_request"');
    expect(http.hintLine('question')).toContain('"cs"');
    // 강제가 아니라 우선 고려다 — 유저가 칩 문장을 지우고 딴 얘기를 쓸 수 있다
    expect(http.hintLine('bug')).toContain('follow the content if it says otherwise');
  });

  it('힌트가 없으면 프롬프트에 아무것도 덧붙이지 않는다', () => {
    expect(http.hintLine(null)).toBe('');
    expect(http.hintLine(undefined)).toBe('');
  });

  it('config 가 주는 칩과 hint 검증이 같은 목록을 본다', () => {
    for (const chip of http.WIDGET_CHIPS) {
      expect(http.isWidgetHint(chip.hint)).toBe(true);
      expect(chip.label.length).toBeGreaterThan(0);
    }
    // 첫 화면 아래 줄은 의견 알약 둘뿐이다. 예전의 「문의할 게 있어요」는
    // 시작 질문 칩으로 대체됐다 — 다만 question 힌트 자체는 그 칩이 계속 쓴다.
    expect(http.WIDGET_CHIPS).toHaveLength(2);
    expect(http.WIDGET_CHIPS.map((c) => c.hint)).toEqual(['bug', 'feature']);
    expect(http.isWidgetHint(http.STARTER_QUESTION_HINT)).toBe(true);
    expect(http.WIDGET_CHIPS.some((c) => c.hint === http.STARTER_QUESTION_HINT)).toBe(false);
  });
});
