import { describe, it, expect, vi } from 'vitest';

// I-05 — 배치 분류의 done-set 판정이 보충 턴(source_message_ids) 도 보는지 검증한다.
// 안 그러면 [분류] 버튼이 위젯 즉답이 이미 기존 인사이트에 흡수한 메시지를 새
// 인사이트로 만들어, 대화 1개 → 인사이트 여러 개 문제가 배치 경로로 뒷문 재발한다.
//
// 두 쿼리가 «어느 컬럼에» 걸렸는지까지 단언한다. 이 판정은 조용히 틀린다 —
// overlaps 를 엉뚱한 컬럼에 걸어도 결과가 비어 돌아올 뿐 에러가 안 나고,
// 화면에는 「분류할 게 없어요」로 보인다.
//
// route.ts 는 이 함수 말고도 여러 모듈을 정적 import 한다(getBotConfigFromDB·callLlm 등).
// 그 모듈들의 실제 로직(암호화 키 로드 등)이 모듈 로드 시점에 돌면 이 테스트와 무관한
// 이유로 깨질 수 있어 전부 빈 mock 으로 막는다 — llm-key-route.test.ts 와 같은 패턴.
vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: vi.fn() }));
vi.mock('@/lib/auth/ownership', () => ({ resolveOwnedBots: vi.fn() }));
vi.mock('@/lib/bot/core', () => ({ getBotConfigFromDB: vi.fn() }));
vi.mock('@/lib/bot/handler', () => ({ callLlm: vi.fn() }));
vi.mock('@/lib/llm/usage', () => ({
  bumpUsage: vi.fn(),
  resolveLimit: vi.fn(),
  isOverLimit: vi.fn(),
}));
vi.mock('@/lib/classify/batch', () => ({
  buildBatchSystemPrompt: vi.fn(),
  buildBatchUserPrompt: vi.fn(),
  parseBatchResponse: vi.fn(),
  validateClassifications: vi.fn(),
}));

type Mod = typeof import('@/app/api/classify/route');

async function load(): Promise<Mod> {
  vi.resetModules();
  return import('@/app/api/classify/route');
}

interface Recorded {
  select: string;
  in: [string, string[]][];
  overlaps: [string, string[]] | null;
}

/**
 * `.from().select().in()...` 체인을 기록하는 최소 가짜 db.
 * 마지막 호출이 `.in('message_id', …)` 이냐 `.overlaps(…)` 이냐로 두 쿼리를 가른다.
 */
function fakeDb(responses: {
  in: { data: unknown[] | null; error: { message: string } | null };
  overlaps: { data: unknown[] | null; error: { message: string } | null };
}) {
  const recorded: Recorded[] = [];

  const client = {
    from: vi.fn(() => ({
      select: vi.fn((select: string) => {
        const entry: Recorded = { select, in: [], overlaps: null };
        recorded.push(entry);
        const chain = {
          in: vi.fn((col: string, values: string[]) => {
            entry.in.push([col, values]);
            // bot_id 스코프는 체인 중간이고, message_id 가 마지막이라 그때 결과를 돌려준다.
            return col === 'bot_id' ? chain : Promise.resolve(responses.in);
          }),
          overlaps: vi.fn((col: string, values: string[]) => {
            entry.overlaps = [col, values];
            return Promise.resolve(responses.overlaps);
          }),
        };
        return chain;
      }),
    })),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, recorded };
}

describe('fetchClassifiedIds — 보충 턴(source_message_ids) 도 done 에 넣는다', () => {
  it('message_id 로 직접 분류된 것과 source_message_ids 로 보충된 것을 모두 done 에 넣는다', async () => {
    const mod = await load();

    const { client, recorded } = fakeDb({
      in: { data: [{ message_id: 'a' }], error: null },
      // 'b' 는 이번 청크(a,b,c) 소속이라 done 에 들어가야 하고,
      // 'x' 는 이번 청크 밖이라 걸러야 한다(다른 청크 차례에 각자 처리된다).
      overlaps: { data: [{ source_message_ids: ['b', 'x'] }], error: null },
    });

    const done = await mod.fetchClassifiedIds(client, ['a', 'b', 'c'], ['bot-1']);

    expect(done.has('a')).toBe(true);
    expect(done.has('b')).toBe(true);
    expect(done.has('c')).toBe(false);
    expect(done.has('x')).toBe(false);
    // 두 쿼리가 모두 호출됐는지 — 하나만 치면 회귀를 못 잡는다.
    expect(client.from).toHaveBeenCalledWith('insights');
    expect(recorded).toHaveLength(2);
  });

  it('overlaps 는 반드시 source_message_ids 컬럼에 건다 — 다른 컬럼이면 조용히 빈 결과가 된다', async () => {
    const mod = await load();
    const { recorded, client } = fakeDb({
      in: { data: [], error: null },
      overlaps: { data: [], error: null },
    });

    await mod.fetchClassifiedIds(client, ['a', 'b'], ['bot-1']);

    const ext = recorded.find((r) => r.overlaps !== null);
    expect(ext?.select).toBe('source_message_ids');
    expect(ext?.overlaps).toEqual(['source_message_ids', ['a', 'b']]);
  });

  it('두 조회 모두 소유한 봇으로 좁힌다 — service_role 이라 RLS 가 막아 주지 않는다', async () => {
    const mod = await load();
    const { recorded, client } = fakeDb({
      in: { data: [], error: null },
      overlaps: { data: [], error: null },
    });

    await mod.fetchClassifiedIds(client, ['a'], ['bot-1', 'bot-2']);

    expect(recorded).toHaveLength(2);
    for (const entry of recorded) {
      expect(entry.in).toContainEqual(['bot_id', ['bot-1', 'bot-2']]);
    }
  });

  it('둘 다 빈 결과면 done 이 빈 채로 남는다', async () => {
    const mod = await load();
    const { client } = fakeDb({
      in: { data: [], error: null },
      overlaps: { data: [], error: null },
    });

    const done = await mod.fetchClassifiedIds(client, ['a', 'b'], ['bot-1']);

    expect(done.size).toBe(0);
  });

  it('overlaps 쿼리가 에러면 던진다', async () => {
    const mod = await load();
    const { client } = fakeDb({
      in: { data: [], error: null },
      overlaps: { data: null, error: { message: 'boom' } },
    });

    await expect(mod.fetchClassifiedIds(client, ['a'], ['bot-1'])).rejects.toThrow('boom');
  });
});
