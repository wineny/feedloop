import { describe, it, expect, vi, beforeEach } from 'vitest';

// 위젯 「연결됨」 표시를 찍는 UPDATE 의 **조건**을 본다.
//
// 여기서 지키는 것은 하나다 — 채널톡 키가 저장된 봇에서는 이 표시가 되살아나지 않는다.
// 입구는 한 번에 하나인데(`lib/connect/exclusive.ts`) 위젯은 서버가 내릴 수 없다.
// 운영자가 「연결 해제」를 눌러도 고객사 페이지에 스크립트가 남아 있으면 다음 방문자가
// 열 때 이 UPDATE 가 돌고, 조건이 없으면 방금 내린 입구가 저절로 다시 켜진다.
//
// 조건은 쿼리에만 있어서 눈으로는 안 보이고 조용히 틀린다. 그래서 필터를 기록해 단언한다.

interface UpdateCall {
  table: string;
  patch: Record<string, unknown>;
  filters: [string, string, unknown][];
}

let updateCalls: UpdateCall[] = [];
let updateError: { message: string } | null = null;

const fromMock = vi.fn((table: string) => ({
  update: vi.fn((patch: Record<string, unknown>) => {
    const record: UpdateCall = { table, patch, filters: [] };
    updateCalls.push(record);

    const chain: Record<string, unknown> = {};
    for (const method of ['eq', 'is']) {
      chain[method] = vi.fn((col: string, val: unknown) => {
        record.filters.push([method, col, val]);
        return chain;
      });
    }
    chain.then = (resolve: (v: unknown) => void) => resolve({ error: updateError });
    return chain;
  }),
}));

vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: () => ({ from: fromMock }) }));

const BOT_ID = '22222222-2222-4222-8222-222222222222';

async function markConnected() {
  vi.resetModules();
  const { markWidgetConnected } = await import('@/lib/widget/connected');
  await markWidgetConnected(BOT_ID);
  return updateCalls[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  updateCalls = [];
  updateError = null;
});

describe('markWidgetConnected — 표시를 찍는 조건', () => {
  it('bots 한 행에 시각을 찍는다', async () => {
    const call = await markConnected();

    expect(call.table).toBe('bots');
    expect(Object.keys(call.patch)).toEqual(['widget_connected_at']);
    expect(typeof call.patch.widget_connected_at).toBe('string');
    expect(call.filters).toContainEqual(['eq', 'id', BOT_ID]);
  });

  it('이미 찍힌 봇은 건드리지 않는다 — 첫 연결 시각을 매 폴링마다 밀면 안 된다', async () => {
    const call = await markConnected();
    expect(call.filters).toContainEqual(['is', 'widget_connected_at', null]);
  });

  it('채널톡 키가 저장돼 있으면 안 찍는다 — 내린 입구가 저절로 되살아나면 안 된다', async () => {
    const call = await markConnected();
    expect(call.filters).toContainEqual(['is', 'channel_webhook_token_encrypted', null]);
  });

  it('기준은 channel_connected_at 이 아니라 «키가 저장됐는지»다', async () => {
    // 키를 저장하고 채널톡에 웹훅을 등록하는 몇 분 동안 channel_connected_at 은 아직 NULL 이다.
    // 그 틈에 방문자 한 명이 옛 위젯을 열면 둘 다 켜진 봇이 만들어진다.
    const call = await markConnected();
    const columns = call.filters.map(([, col]) => col);
    expect(columns).not.toContain('channel_connected_at');
  });

  it('실패해도 던지지 않는다 — 표시 하나 때문에 방문자 응답을 깨지 않는다', async () => {
    updateError = { message: 'column does not exist' };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(markConnected()).resolves.toBeDefined();
    expect(spy).toHaveBeenCalled();

    spy.mockRestore();
  });
});
