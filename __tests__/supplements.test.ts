import { describe, it, expect, vi, beforeEach } from 'vitest';

// I-05 — 위젯 즉답이 꼬리질문 답을 기존 인사이트 갱신(source_message_ids)으로 흡수하므로,
// 제보의 «실제 내용»이 messages.body 한 줄이 아니라 여러 턴에 흩어진다.
// 그 원문을 읽는 소비처가 둘(자동 PR 엔진 · 스펙 초안)이라 규칙이 한 곳에 있어야 한다.

interface Recorded {
  select: string;
  eq: [string, string][];
  in: [string, string[]][];
  order: [string, unknown][];
}

let recorded: Recorded[] = [];
let rows: unknown[] = [];
let queryError: { message: string } | null = null;

const fromMock = vi.fn(() => ({
  select: (select: string) => {
    const entry: Recorded = { select, eq: [], in: [], order: [] };
    recorded.push(entry);
    const chain = {
      eq: (col: string, value: string) => {
        entry.eq.push([col, value]);
        return chain;
      },
      in: (col: string, values: string[]) => {
        entry.in.push([col, values]);
        return chain;
      },
      order: (col: string, opts: unknown) => {
        entry.order.push([col, opts]);
        return Promise.resolve({ data: rows, error: queryError });
      },
    };
    return chain;
  },
}));

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({ from: fromMock }),
}));

describe('appendSupplements', () => {
  let appendSupplements: typeof import('@/lib/insights/supplements').appendSupplements;

  beforeEach(async () => {
    vi.resetModules();
    ({ appendSupplements } = await import('@/lib/insights/supplements'));
  });

  it('보충이 없으면 원문 그대로 돌려준다', () => {
    expect(appendSupplements('쿠폰함 확인 안 돼요', [])).toBe('쿠폰함 확인 안 돼요');
  });

  it('보충 턴 본문을 「(follow-up) …」 줄로 덧붙인다', () => {
    expect(appendSupplements('쿠폰함 확인 안 돼요', ['흰 화면이에요. PC 크롬'])).toBe(
      '쿠폰함 확인 안 돼요\n(follow-up) 흰 화면이에요. PC 크롬',
    );
  });

  it('보충 여러 건은 등장 순서대로 각자 한 줄씩 붙인다', () => {
    expect(appendSupplements('원문', ['보충1', '보충2', '보충3'])).toBe(
      '원문\n(follow-up) 보충1\n(follow-up) 보충2\n(follow-up) 보충3',
    );
  });
});

describe('loadSupplementBodies', () => {
  let mod: typeof import('@/lib/insights/supplements');

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    recorded = [];
    rows = [];
    queryError = null;
    mod = await import('@/lib/insights/supplements');
  });

  it('봇으로 스코프를 건다 — 이 본문은 PR 본문에 그대로 실린다', async () => {
    rows = [{ body: '흰 화면이에요' }];

    await mod.loadSupplementBodies(['m-2'], 'bot-1');

    expect(recorded).toHaveLength(1);
    expect(recorded[0].eq).toContainEqual(['bot_id', 'bot-1']);
    expect(recorded[0].in).toContainEqual(['id', ['m-2']]);
  });

  it('시각 오름차순으로 읽는다 — 보충은 순서가 곧 뜻이다(증상 → 기기 → 재현 조건)', async () => {
    rows = [{ body: 'a' }];

    await mod.loadSupplementBodies(['m-2'], 'bot-1');

    expect(recorded[0].order).toContainEqual(['detected_at', { ascending: true }]);
  });

  it('인사이트당 3건(SUPPLEMENT_LIMIT)까지만 읽는다 — 프롬프트가 무한정 커지지 않게', async () => {
    rows = [];

    await mod.loadSupplementBodies(['m1', 'm2', 'm3', 'm4', 'm5'], 'bot-1');

    expect(mod.SUPPLEMENT_LIMIT).toBe(3);
    expect(recorded[0].in).toContainEqual(['id', ['m1', 'm2', 'm3']]);
  });

  it('빈 배열·null 이면 조회하지 않는다', async () => {
    expect(await mod.loadSupplementBodies([], 'bot-1')).toEqual([]);
    expect(await mod.loadSupplementBodies(null, 'bot-1')).toEqual([]);
    expect(recorded).toHaveLength(0);
  });

  it('긴 본문은 상한에서 자르고 잘렸음을 표시한다', async () => {
    rows = [{ body: '가'.repeat(mod.SUPPLEMENT_CHARS + 50) }];

    const out = await mod.loadSupplementBodies(['m-2'], 'bot-1');

    expect(out).toEqual([`${'가'.repeat(mod.SUPPLEMENT_CHARS)}…`]);
  });

  it('빈 본문은 버린다 — 「(follow-up) 」 만 있는 줄이 프롬프트에 남으면 안 된다', async () => {
    rows = [{ body: '   ' }, { body: '진짜 보충' }, {}];

    expect(await mod.loadSupplementBodies(['m-2'], 'bot-1')).toEqual(['진짜 보충']);
  });

  it('조회가 실패하면 빈 배열이다 — 보충을 못 읽어도 원 제보로는 돌아간다', async () => {
    queryError = { message: 'boom' };
    rows = null as unknown as unknown[];

    expect(await mod.loadSupplementBodies(['m-2'], 'bot-1')).toEqual([]);
  });
});
