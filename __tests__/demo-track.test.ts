// 레인 A — 라이브 데모 「내 제보 추적」 (2026-09-18)
//
// 두 덩어리를 지킨다:
//   ① widget.js 의 `notifyParent` — **데모 모드(iframe) 밖에서는 절대 안 나간다.**
//      널널투어는 실서비스이고 위젯은 남의 페이지에서도 돈다. 여기가 새면 방문자 제보 id 가
//      아무 호스트 페이지로 흘러간다.
//   ② `/api/public/demo-track` — 무인증 공개 라우트. 허용 목록·소유 검사·본문 비노출.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';

const { checkReadRate, from } = vi.hoisted(() => ({ checkReadRate: vi.fn(), from: vi.fn() }));

vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: () => ({ from }) }));
vi.mock('@/lib/widget/http', async (original) => ({
  ...(await original<typeof import('@/lib/widget/http')>()),
  checkReadRate,
}));

import { GET } from '@/app/api/public/demo-track/route';

// ── ① widget.js 의 postMessage 게이트 ──────────────────────────

const widgetSrc = readFileSync(new URL('../public/widget.js', import.meta.url), 'utf8');

/** widget.js 소스에서 함수 본문 하나를 떼어낸다(색 함수 테스트와 같은 방식). */
function grab(name: string): string {
  const start = widgetSrc.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} 을 못 찾았다`);
  let depth = 0;
  for (let i = widgetSrc.indexOf('{', start); i < widgetSrc.length; i++) {
    if (widgetSrc[i] === '{') depth++;
    else if (widgetSrc[i] === '}') {
      depth--;
      if (depth === 0) return widgetSrc.slice(start, i + 1);
    }
  }
  throw new Error(`${name} 의 본문이 안 닫혔다`);
}

interface PostCall {
  data: Record<string, unknown>;
  targetOrigin: string;
}

/**
 * 위젯이 실제로 도는 모양으로 `notifyParent` 를 세운다.
 * `inFrame:false` 면 `window.parent === window` — 즉 고객 사이트에 그냥 붙은 평소 상태다.
 */
function loadNotifyParent(opts: { inFrame: boolean }) {
  const calls: PostCall[] = [];
  const postMessage = (data: Record<string, unknown>, targetOrigin: string) => {
    calls.push({ data, targetOrigin });
  };
  // ⚠️ 최상위 창«에도» postMessage 가 있다. 없는 fake 를 쓰면 게이트를 지워도 예외가 나고
  // notifyParent 의 try/catch 가 그걸 삼켜 «테스트가 초록인 채로» 게이트가 죽는다
  // (음성 대조 NC1 에서 실제로 한 번 겪었다 — 이 레포의 단골 실패다).
  const win: Record<string, unknown> = { postMessage };
  win.parent = opts.inFrame ? { postMessage } : win;

  const body = [
    'var window = __win;',
    "var botId = 'bot-1';",
    "var visitorId = 'visitor-1';",
    "var ORIGIN = 'https://ai-feedloop.vercel.app';",
    grab('notifyParent'),
    'return notifyParent;',
  ].join('\n');

  const fn = new Function('__win', body)(win) as (msg: Record<string, unknown>) => void;
  return { fn, calls };
}

describe('widget.js notifyParent — 데모 모드 밖으로는 한 글자도 안 나간다', () => {
  const feedback = { type: 'feedback', messageId: 'msg-1', visitorId: 'visitor-1' };

  it('🔴 iframe 밖(=고객 사이트 평소 상태)에서는 postMessage 를 아예 안 부른다', () => {
    const { fn, calls } = loadNotifyParent({ inFrame: false });
    fn({ ...feedback });
    fn({ type: 'opened' });
    expect(calls).toHaveLength(0);
  });

  it('iframe 안에서는 제보 id 를 한 번만 건넨다', () => {
    const { fn, calls } = loadNotifyParent({ inFrame: true });
    fn({ ...feedback });
    expect(calls).toHaveLength(1);
    expect(calls[0].data).toEqual({
      source: 'feedloop-widget',
      type: 'feedback',
      botId: 'bot-1',
      messageId: 'msg-1',
      visitorId: 'visitor-1',
    });
  });

  it('창이 열렸다는 알림에는 제보 내용이 안 실린다', () => {
    const { fn, calls } = loadNotifyParent({ inFrame: true });
    fn({ type: 'opened' });
    expect(calls[0].data).toEqual({ source: 'feedloop-widget', type: 'opened', botId: 'bot-1' });
  });

  it('🔴 targetOrigin 은 우리 오리진이다 — 절대 와일드카드가 아니다', () => {
    const { fn, calls } = loadNotifyParent({ inFrame: true });
    fn({ ...feedback });
    fn({ type: 'opened' });
    for (const c of calls) {
      expect(c.targetOrigin).toBe('https://ai-feedloop.vercel.app');
      expect(c.targetOrigin).not.toBe('*');
    }
  });

  it('제보 id 가 없으면(저장 실패·옛 서버 응답) 아무것도 안 보낸다', () => {
    // 이 가드는 부르는 쪽에 있다 — 없는 id 로 부르지 않는다.
    expect(widgetSrc).toMatch(/if \(res\.data\.messageId\) notifyParent\(\{ type: 'feedback'/);
  });

  it('🔴 「창 열어라」는 iframe 안에서, 우리 오리진에서 온 것만 받는다', () => {
    // 이 위젯은 남의 사이트에서도 돈다. 게이트가 빠지면 아무나 그 사이트를 iframe 에 넣고
    // 방문자 화면의 챗봇 창을 열 수 있다. 등록 자체가 iframe 안에서만 일어나야 하고,
    // 핸들러 첫 줄이 오리진을 봐야 한다.
    const at = widgetSrc.indexOf('if (window.parent !== window) {');
    expect(at, 'iframe 게이트 밖에서 리스너를 걸고 있다').toBeGreaterThan(-1);
    let depth = 0;
    let block = '';
    for (let i = widgetSrc.indexOf('{', at); i < widgetSrc.length; i++) {
      if (widgetSrc[i] === '{') depth++;
      else if (widgetSrc[i] === '}') {
        depth--;
        if (depth === 0) {
          block = widgetSrc.slice(at, i + 1);
          break;
        }
      }
    }
    expect(block).toMatch(/addEventListener\('message'/);
    expect(block).toMatch(/if \(e\.origin !== ORIGIN\) return;/);
    expect(block).toMatch(/d\.source !== 'feedloop-demo'/);
    expect(block).toMatch(/d\.type !== 'open'/);
    // 오리진 검사가 메시지 내용 검사보다 «앞»에 있어야 한다.
    expect(block.indexOf('e.origin !== ORIGIN')).toBeLessThan(block.indexOf("d.source !== 'feedloop-demo'"));
    // 창을 여는 것 말고는 아무것도 시키지 못한다.
    expect(block).toMatch(/if \(!state\.open\) toggle\(\);/);
  });

  it('🔴 message 리스너는 이 한 곳뿐이다', () => {
    // 다른 자리에 오리진 검사 없는 리스너가 생기면 위 검사를 통째로 우회한다.
    expect(widgetSrc.match(/addEventListener\('message'/g) ?? []).toHaveLength(1);
  });

  it("🔴 소스 어디에도 postMessage(..., '*') 가 없다", () => {
    // 위 동작 테스트는 notifyParent 만 본다. 파일 전체를 한 번 더 훑어
    // 누가 «다른 자리»에 브로드캐스트를 넣는 것을 막는다.
    expect(widgetSrc).not.toMatch(/postMessage\([^)]*,\s*['"]\*['"]/);
  });
});

// ── ② /api/public/demo-track ────────────────────────────────

const BOT = '8cb62530-1c10-498f-b03d-8c51ad31d4c6';       // 허용 목록에 든 데모 봇(널널투어)
const OTHER_BOT = '22000000-0000-4000-8000-000000000001'; // 목록 밖
const MSG = '22000000-0000-4000-8000-000000000002';
const VISITOR = '22000000-0000-4000-8000-000000000003';
const GROUP = '22000000-0000-4000-8000-000000000004';

/** 테이블별 응답을 갈아 끼우는 가짜 db. 필터는 기록해 두고 단언에 쓴다. */
let tables: Record<string, unknown>;
let filters: { table: string; method: string; args: unknown[] }[];

function fakeTable(table: string) {
  const chain: Record<string, unknown> = {};
  const record = (method: string) => (...args: unknown[]) => {
    filters.push({ table, method, args });
    return chain;
  };
  for (const m of ['select', 'eq', 'or', 'limit']) chain[m] = vi.fn(record(m));
  chain.maybeSingle = vi.fn(async () => tables[table] ?? { data: null, error: null });
  chain.then = (resolve: (v: unknown) => void) => resolve(tables[table] ?? { data: [], error: null });
  return chain;
}

const call = (params: Record<string, string>) =>
  GET(new NextRequest(`http://localhost/api/public/demo-track?${new URLSearchParams(params)}`));

beforeEach(() => {
  vi.clearAllMocks();
  filters = [];
  tables = {};
  checkReadRate.mockReturnValue(null);
  from.mockImplementation((table: string) => fakeTable(table));
});

describe('demo-track — 무인증 공개 라우트의 관문', () => {
  it('🔴 허용 목록 밖 봇은 404 — DB 를 건드리지도 않는다', async () => {
    const res = await call({ botId: OTHER_BOT, messageId: MSG, visitorId: VISITOR });
    expect(res.status).toBe(404);
    expect(from).not.toHaveBeenCalled();
  });

  it('botId 가 없으면 404', async () => {
    expect((await call({ messageId: MSG, visitorId: VISITOR })).status).toBe(404);
    expect(from).not.toHaveBeenCalled();
  });

  it.each([
    { messageId: 'not-a-uuid', visitorId: VISITOR },
    { messageId: MSG, visitorId: 'not-a-uuid' },
    { messageId: MSG },
    { visitorId: VISITOR },
    // 필터 주입 시도 — UUID 검사에서 걸려야 한다(.or() 는 문자열 필터다)
    { messageId: `${MSG},category.eq.bug`, visitorId: VISITOR },
  ])('형식이 아니면 400 이고 DB 를 안 친다 %j', async (params) => {
    const res = await call({ botId: BOT, ...(params as Record<string, string>) });
    expect(res.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it('레이트 리밋이 걸리면 그대로 돌려준다', async () => {
    checkReadRate.mockReturnValue(new Response(null, { status: 429 }));
    expect((await call({ botId: BOT, messageId: MSG, visitorId: VISITOR })).status).toBe(429);
    expect(from).not.toHaveBeenCalled();
  });

  it('🔴 남의 제보는 404 — messageId 와 visitorId 가 같은 행에서 맞아야 한다', async () => {
    tables.messages = { data: null, error: null };
    const res = await call({ botId: BOT, messageId: MSG, visitorId: VISITOR });
    expect(res.status).toBe(404);

    // 소유 검사가 «쿼리에» 있어야 한다. 코드에서 거르면 다음 사람이 컬럼을 하나 지워도 초록이다.
    const eqs = filters.filter((f) => f.table === 'messages' && f.method === 'eq').map((f) => f.args);
    expect(eqs).toEqual(
      expect.arrayContaining([
        ['id', MSG],
        ['bot_id', BOT],
        ['external_user_id', VISITOR],
        ['source', 'web'],
      ]),
    );
  });

  it('메시지 조회가 실패하면 성공이라고 하지 않는다', async () => {
    tables.messages = { data: null, error: { code: 'XX000', message: 'boom' } };
    expect((await call({ botId: BOT, messageId: MSG, visitorId: VISITOR })).status).toBe(503);
  });
});

describe('demo-track — 단계', () => {
  const received = '2026-09-18T01:00:00Z';

  beforeEach(() => {
    tables.messages = { data: { id: MSG, detected_at: received }, error: null };
  });

  it('분류 전이면 「접수됨」', async () => {
    tables.insights = { data: [], error: null };
    const body = await (await call({ botId: BOT, messageId: MSG, visitorId: VISITOR })).json();
    expect(body).toEqual({
      stage: 'received',
      category: null,
      categoryLabel: null,
      groupSize: null,
      at: { received, classified: null, grouped: null },
    });
  });

  it('분류됐으면 「분류됨」 + 한국어 라벨', async () => {
    tables.insights = {
      data: [{ category: 'bug', created_at: '2026-09-18T01:00:05Z', updated_at: null, group_id: null }],
      error: null,
    };
    const body = await (await call({ botId: BOT, messageId: MSG, visitorId: VISITOR })).json();
    expect(body.stage).toBe('classified');
    expect(body.category).toBe('bug');
    expect(body.categoryLabel).toBe('버그');
    expect(body.at.classified).toBe('2026-09-18T01:00:05Z');
  });

  it('보충 턴도 따라간다 — message_id 와 source_message_ids 를 같이 본다', async () => {
    tables.insights = {
      data: [{ category: 'ux', created_at: 'x', updated_at: null, group_id: null }],
      error: null,
    };
    await call({ botId: BOT, messageId: MSG, visitorId: VISITOR });
    const or = filters.find((f) => f.table === 'insights' && f.method === 'or');
    expect(or?.args[0]).toBe(`message_id.eq.${MSG},source_message_ids.cs.{${MSG}}`);
  });

  it('묶였으면 「묶임」 + 건수', async () => {
    tables.insights = {
      data: [{ category: 'bug', created_at: 'x', updated_at: null, group_id: GROUP }],
      error: null,
    };
    tables.insight_groups = { data: { created_at: '2026-09-18T01:02:00Z' }, error: null };
    // 묶음 건수는 head count 로 온다
    from.mockImplementation((table: string) => {
      const chain = fakeTable(table);
      if (table === 'insights') {
        const selects = filters.filter((f) => f.table === 'insights' && f.method === 'select').length;
        if (selects >= 1) chain.then = (r: (v: unknown) => void) => r({ count: 3, data: null, error: null });
      }
      return chain;
    });
    const body = await (await call({ botId: BOT, messageId: MSG, visitorId: VISITOR })).json();
    expect(body.stage).toBe('grouped');
    expect(body.groupSize).toBe(3);
    expect(body.at.grouped).toBe('2026-09-18T01:02:00Z');
  });

  it('🔴 어떤 단계에서도 제보 본문·요약·묶음 제목이 안 나간다', async () => {
    tables.insights = {
      data: [{ category: 'bug', created_at: 'x', updated_at: null, group_id: GROUP }],
      error: null,
    };
    tables.insight_groups = { data: { created_at: 'y' }, error: null };
    const body = await (await call({ botId: BOT, messageId: MSG, visitorId: VISITOR })).json();
    const keys = JSON.stringify(body);
    for (const leaked of ['body', 'summary', 'title', 'contact', 'author']) {
      expect(keys).not.toContain(`"${leaked}"`);
    }
    // select 에 본문 컬럼을 넣지 않는다 — 넣어두면 다음 사람이 행을 그대로 실을 때 샌다
    const sel = filters.filter((f) => f.method === 'select').map((f) => String(f.args[0]));
    for (const s of sel) {
      expect(s).not.toMatch(/\bbody\b/);
      expect(s).not.toMatch(/\bsummary\b/);
      expect(s).not.toMatch(/\btitle\b/);
    }
  });

  it('캐시하지 않는다 — CDN 이 「접수됨」을 물면 데모가 1단계에 멈춘다', async () => {
    tables.insights = { data: [], error: null };
    const res = await call({ botId: BOT, messageId: MSG, visitorId: VISITOR });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
