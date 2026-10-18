import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// isBotConnected 는 「이 봇이 채널에 붙었나」를 판정한다. 채널톡이 들어오면서
// «어느 채널의» 메시지를 세는지가 중요해졌다 — 안 좁히면 채널톡 메시지 1건이
// 카카오 탭을 「연결됨」으로 만든다(수용 기준 20).

const inMock = vi.fn();
const eqMock = vi.fn();
const selectMock = vi.fn();
let count = 0;

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: () => ({
      select: selectMock,
    }),
  }),
}));

function makeChain() {
  const chain: Record<string, unknown> = {};
  chain.eq = eqMock.mockImplementation(() => chain);
  chain.in = inMock.mockImplementation(() => chain);
  chain.then = (resolve: (v: unknown) => void) => resolve({ count, error: null });
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  count = 0;
  selectMock.mockImplementation(() => makeChain());
});

async function load() {
  vi.resetModules();
  return import('@/lib/bot/connection');
}

describe('isBotConnected — 채널 좁히기', () => {
  it('last_active_at 이 있으면 조회조차 하지 않는다', async () => {
    const { isBotConnected } = await load();
    await expect(isBotConnected('bot-1', '2026-09-10T00:00:00Z', ['kakao'])).resolves.toBe(true);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('sources 를 안 주면 오늘과 완전히 동일하다 — 전 채널을 센다', async () => {
    count = 3;
    const { isBotConnected } = await load();
    await expect(isBotConnected('bot-1', null)).resolves.toBe(true);
    expect(inMock).not.toHaveBeenCalled();
  });

  it("['kakao'] 를 주면 카카오 메시지만 센다", async () => {
    count = 1;
    const { isBotConnected } = await load();
    await isBotConnected('bot-1', null, ['kakao']);
    expect(inMock).toHaveBeenCalledWith('source', ['kakao']);
  });

  it('빈 배열은 좁히지 않는다 — 조건이 없는 것과 같게 둔다', async () => {
    const { isBotConnected } = await load();
    await isBotConnected('bot-1', null, []);
    expect(inMock).not.toHaveBeenCalled();
  });

  it('센 게 0이면 아직 연결 안 됨이다', async () => {
    count = 0;
    const { isBotConnected } = await load();
    await expect(isBotConnected('bot-1', null, ['kakao'])).resolves.toBe(false);
  });
});

// 주석만으로는 재발을 못 막는다(계획 §11-11). 호출처가 늘어나는 순간을 여기서 잡는다.
describe('호출처 가드 — 카카오 판정은 반드시 채널을 좁힌다', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(name)) out.push(full);
    }
    return out;
  }

  it('src 안의 모든 isBotConnected 호출이 sources 인자를 넘긴다', async () => {
    const files = walk('src').filter((f) => !f.endsWith('lib/bot/connection.ts'));
    const bare: string[] = [];

    for (const file of files) {
      const text = readFileSync(file, 'utf-8').replace(/\s+/g, ' ');
      for (const m of text.matchAll(/isBotConnected\(([^)]*)\)/g)) {
        // 인자 3개 = 봇·last_active_at·채널 목록. 배열 리터럴이 없으면 안 좁힌 호출이다.
        if (!m[1].includes('[')) bare.push(`${file}: isBotConnected(${m[1]})`);
      }
    }

    expect(bare).toEqual([]);
  });
});
