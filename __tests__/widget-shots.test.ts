import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

// I-55 「화면에서 선택하기」 스크린샷 — 서버 쪽 관문.
// 가짜 Supabase 는 **필터를 실제로 적용**한다. 이 레포에서 필터를 흉내만 내는 가짜가 죽은 기능을
// 초록으로 덮은 적이 다섯 번 있다 — 붙이기 조건(봇·방문자·message_id IS NULL)은 음성 대조까지 본다.

type Row = Record<string, unknown>;
const { tables, storage } = vi.hoisted(() => ({
  tables: { widget_shots: [] as Row[], messages: [] as Row[], insights: [] as Row[] },
  storage: { objects: new Map<string, Uint8Array>(), failRemove: false, failUpload: false },
}));

vi.mock('@/lib/supabase', () => {
  function query(table: keyof typeof tables) {
    const filters: ((r: Row) => boolean)[] = [];
    let op: 'select' | 'update' | 'delete' | 'insert' = 'select';
    let patch: Row = {};
    let head = false;
    let limit = Infinity;
    const q: Record<string, unknown> = {
      select: (_cols?: string, opts?: { head?: boolean }) => {
        if (opts?.head) head = true;
        return q;
      },
      update: (p: Row) => ((op = 'update'), (patch = p), q),
      delete: () => ((op = 'delete'), q),
      insert: (row: Row) => {
        tables[table].push({ message_id: null, created_at: new Date().toISOString(), ...row });
        return Promise.resolve({ error: null });
      },
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
      not: (c: string, op: string, v: unknown) => (filters.push((r) => (op === 'is' ? (r[c] ?? null) !== v : true)), q),
      order: () => q,
      gte: (c: string, v: string) => (filters.push((r) => String(r[c]) >= v), q),
      lt: (c: string, v: string) => (filters.push((r) => String(r[c]) < v), q),
      limit: (n: number) => ((limit = n), q),
      then: (resolve: (v: unknown) => unknown) => {
        const hit = tables[table].filter((r) => filters.every((f) => f(r))).slice(0, limit);
        if (op === 'update') hit.forEach((r) => Object.assign(r, patch));
        if (op === 'delete') tables[table] = tables[table].filter((r) => !hit.includes(r)) as Row[];
        return Promise.resolve({ data: hit, count: hit.length, error: null }).then(resolve);
      },
    };
    return q;
  }
  const bucket = {
    upload: async (path: string, bytes: Uint8Array) => {
      if (storage.failUpload) return { error: { message: 'down' } };
      storage.objects.set(path, bytes);
      return { error: null };
    },
    remove: async (paths: string[]) => {
      if (storage.failRemove) return { error: { message: 'down' } };
      paths.forEach((p) => storage.objects.delete(p));
      return { error: null };
    },
    createSignedUrls: async (paths: string[], ttl: number) => ({
      data: paths.map((p) => ({ path: p, signedUrl: `https://signed.test/${p}?ttl=${ttl}` })),
      error: null,
    }),
  };
  // reserve_widget_shot 의 뜻을 그대로: 방문자 1분·봇 24시간을 세고, 통과하면 그 자리에서 행을 만든다
  const rpc = async (name: string, a: Record<string, unknown>) => {
    if (name !== 'reserve_widget_shot') return { data: null, error: { message: 'unknown rpc' } };
    const now = Date.now();
    const recent = (ms: number) => (r: Row) => Date.parse(String(r.created_at)) > now - ms;
    const mine = tables.widget_shots.filter((r) => r.bot_id === a.p_bot);
    if (mine.filter((r) => r.visitor_id === a.p_visitor).filter(recent(60_000)).length >= (a.p_visitor_limit as number)) return { data: 'visitor', error: null };
    if (mine.filter(recent(86_400_000)).length >= (a.p_bot_limit as number)) return { data: 'bot', error: null };
    tables.widget_shots.push({
      id: a.p_id, bot_id: a.p_bot, visitor_id: a.p_visitor, storage_path: a.p_path, mime: a.p_mime,
      bytes: a.p_bytes, width: a.p_width, height: a.p_height, message_id: null, created_at: new Date().toISOString(),
    });
    return { data: null, error: null };
  };
  return {
    getServiceRoleClient: () => ({
      rpc,
      from: (t: keyof typeof tables) => query(t),
      storage: { from: () => bucket },
    }),
  };
});

const BOT = '11111111-1111-4111-8111-111111111111';
const OTHER_BOT = '22222222-2222-4222-8222-222222222222';
const VISITOR = '33333333-3333-4333-8333-333333333333';
const OTHER_VISITOR = '44444444-4444-4444-8444-444444444444';
const MSG = '55555555-5555-4555-8555-555555555555';

beforeEach(() => {
  tables.widget_shots = [];
  tables.messages = [];
  tables.insights = [];
  storage.objects.clear();
  storage.failRemove = false;
  storage.failUpload = false;
});

async function webp(w = 1280, h = 720) {
  return new Uint8Array(await sharp({ create: { width: w, height: h, channels: 3, background: '#e55' } }).webp({ quality: 75 }).toBuffer());
}

describe('detectShotImage — 매직 바이트', () => {
  it('WebP(손실·무손실)·JPEG 의 형식과 크기를 머리에서 읽는다', async () => {
    const { detectShotImage } = await import('@/lib/widget/shot-image');
    expect(detectShotImage(await webp(1280, 720))).toEqual({ mime: 'image/webp', width: 1280, height: 720 });
    const lossless = new Uint8Array(await sharp({ create: { width: 300, height: 200, channels: 4, background: '#00f8' } }).webp({ lossless: true }).toBuffer());
    expect(detectShotImage(lossless)).toEqual({ mime: 'image/webp', width: 300, height: 200 });
    const jpeg = new Uint8Array(await sharp({ create: { width: 640, height: 480, channels: 3, background: '#0f0' } }).jpeg({ quality: 75 }).toBuffer());
    expect(detectShotImage(jpeg)).toEqual({ mime: 'image/jpeg', width: 640, height: 480 });
  });

  it('PNG·SVG·HTML 은 Content-Type 과 무관하게 거절한다', async () => {
    const { detectShotImage } = await import('@/lib/widget/shot-image');
    const png = new Uint8Array(await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).png().toBuffer());
    expect(detectShotImage(png)).toBeNull();
    expect(detectShotImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    // RIFF·WEBP 머리만 흉내 낸 가짜
    expect(detectShotImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ' + 'x'.repeat(40)))).toBeNull();
    // JPEG SOI 만 있고 SOF 없음
    expect(detectShotImage(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });

  it('가로세로 2560 초과·1MB 초과는 거절한다', async () => {
    const { detectShotImage, MAX_SHOT_BYTES } = await import('@/lib/widget/shot-image');
    expect(detectShotImage(await webp(2600, 100))).toBeNull();
    const big = new Uint8Array(MAX_SHOT_BYTES + 1);
    big.set(await webp(10, 10));
    expect(detectShotImage(big)).toBeNull();
  });
});

describe('storeShot · attachShot', () => {
  it('저장 → 같은 봇·같은 방문자·미부착일 때만 붙는다 (음성 대조 3종)', async () => {
    const { storeShot, attachShot } = await import('@/lib/widget/shots');
    const bytes = await webp();
    const info = { mime: 'image/webp' as const, width: 1280, height: 720 };
    const stored = await storeShot({ botId: BOT, visitorId: VISITOR, bytes, info });
    const id = stored.ok ? stored.id : null;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(storage.objects.size).toBe(1);
    expect([...storage.objects.keys()][0]).toMatch(new RegExp(`^${BOT}/\\d{4}-\\d{2}/${id}\\.webp$`));

    // 다른 방문자 · 다른 봇 → 0행
    expect(await attachShot({ botId: BOT, visitorId: OTHER_VISITOR, messageId: MSG, shotId: id! })).toBe(false);
    expect(await attachShot({ botId: OTHER_BOT, visitorId: VISITOR, messageId: MSG, shotId: id! })).toBe(false);
    expect(tables.widget_shots[0].message_id).toBeNull();

    // 주인 → 붙는다
    expect(await attachShot({ botId: BOT, visitorId: VISITOR, messageId: MSG, shotId: id! })).toBe(true);
    expect(tables.widget_shots[0].message_id).toBe(MSG);

    // 이미 붙은 것을 다른 메시지로 옮길 수 없다
    const other = '66666666-6666-4666-8666-666666666666';
    expect(await attachShot({ botId: BOT, visitorId: VISITOR, messageId: other, shotId: id! })).toBe(false);
    expect(tables.widget_shots[0].message_id).toBe(MSG);
  });

  it('업로드가 실패하면 예약한 행을 지운다(행만 남는 일도, 객체만 남는 일도 없다)', async () => {
    storage.failUpload = true;
    const { storeShot } = await import('@/lib/widget/shots');
    const r = await storeShot({ botId: BOT, visitorId: VISITOR, bytes: await webp(), info: { mime: 'image/webp', width: 1280, height: 720 } });
    expect(r).toEqual({ ok: false, limit: null });
    expect(tables.widget_shots).toHaveLength(0);
  });

  it('예약 단계의 상한 — 여섯 번째는 올리지도 않는다 (보안 리뷰 M1)', async () => {
    const { storeShot } = await import('@/lib/widget/shots');
    const info = { mime: 'image/webp' as const, width: 10, height: 10 };
    const bytes = await webp(10, 10);
    const rs = [];
    for (let i = 0; i < 6; i++) rs.push(await storeShot({ botId: BOT, visitorId: VISITOR, bytes, info }));
    expect(rs.slice(0, 5).every((r) => r.ok)).toBe(true);
    expect(rs[5]).toEqual({ ok: false, limit: 'visitor' });
    expect(storage.objects.size).toBe(5);
  });

  it('settleMessageShot — 못 붙이면 context 에서 shot 을 떼고 나머지는 남긴다', async () => {
    const { storeShot, settleMessageShot } = await import('@/lib/widget/shots');
    const stored = await storeShot({ botId: BOT, visitorId: OTHER_VISITOR, bytes: await webp(), info: { mime: 'image/webp', width: 1280, height: 720 } });
    const id = stored.ok ? stored.id : '';
    const context = { url: 'https://x.test/', target: { kind: '버튼', tag: 'button', selector: 'button', shot: id } };
    tables.messages.push({ id: MSG, context });
    await settleMessageShot({ botId: BOT, visitorId: VISITOR, messageId: MSG, context });
    const saved = tables.messages[0].context as { target: Record<string, unknown>; url: string };
    expect(saved.target.shot).toBeUndefined();
    expect(saved.target.selector).toBe('button');
    expect(saved.url).toBe('https://x.test/');
    expect(tables.widget_shots[0].message_id).toBeNull();
  });
});

describe('checkShotRate', () => {
  it('방문자 분당 5장 · 봇 하루 300장', async () => {
    const { checkShotRate } = await import('@/lib/widget/shots');
    const now = new Date().toISOString();
    for (let i = 0; i < 5; i++) tables.widget_shots.push({ id: `v${i}`, bot_id: BOT, visitor_id: VISITOR, created_at: now });
    expect(await checkShotRate(BOT, VISITOR)).toBe('visitor');
    expect(await checkShotRate(BOT, OTHER_VISITOR)).toBeNull();
    for (let i = 0; i < 295; i++) tables.widget_shots.push({ id: `b${i}`, bot_id: BOT, visitor_id: `x${i}`, created_at: now });
    expect(await checkShotRate(BOT, OTHER_VISITOR)).toBe('bot');
    // 다른 봇은 안 막힌다
    expect(await checkShotRate(OTHER_BOT, VISITOR)).toBeNull();
  });
});

describe('signShotsForMessages · removeBotShots · cleanupShots', () => {
  it('메시지에 붙은 것만 10분 서명 URL 로 싣는다', async () => {
    tables.widget_shots.push(
      { id: 'a', bot_id: BOT, message_id: MSG, storage_path: `${BOT}/2026-09/a.webp`, width: 1280, height: 720 },
      { id: 'b', bot_id: BOT, message_id: null, storage_path: `${BOT}/2026-09/b.webp`, width: 1, height: 1 },
    );
    const { signShotsForMessages } = await import('@/lib/widget/shots');
    const out = await signShotsForMessages([MSG], [BOT]);
    expect(Object.keys(out)).toEqual([MSG]);
    expect(out[MSG]).toEqual({ url: `https://signed.test/${BOT}/2026-09/a.webp?ttl=600`, width: 1280, height: 720 });
    expect(await signShotsForMessages([], [BOT])).toEqual({});
    // 봇 범위 밖이면 서명하지 않는다(보안 리뷰 L2)
    expect(await signShotsForMessages([MSG], [OTHER_BOT])).toEqual({});
  });

  it('봇 삭제 전 정리 — 그 봇의 객체만 지우고, 저장소 실패면 false', async () => {
    storage.objects.set(`${BOT}/2026-09/a.webp`, new Uint8Array(1));
    storage.objects.set(`${OTHER_BOT}/2026-09/b.webp`, new Uint8Array(1));
    tables.widget_shots.push(
      { id: 'a', bot_id: BOT, storage_path: `${BOT}/2026-09/a.webp` },
      { id: 'b', bot_id: OTHER_BOT, storage_path: `${OTHER_BOT}/2026-09/b.webp` },
    );
    const { removeBotShots } = await import('@/lib/widget/shots');
    storage.failRemove = true;
    expect(await removeBotShots(BOT)).toBe(false);
    storage.failRemove = false;
    expect(await removeBotShots(BOT)).toBe(true);
    expect([...storage.objects.keys()]).toEqual([`${OTHER_BOT}/2026-09/b.webp`]);
  });

  it('고아(24시간·미부착)와 90일 지난 것만 지운다', async () => {
    const now = Date.parse('2026-12-31T00:00:00Z');
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    const H = 3_600_000;
    const rows = [
      { id: 'fresh-orphan', message_id: null, created_at: iso(2 * H) },
      { id: 'old-orphan', message_id: null, created_at: iso(25 * H) },
      { id: 'attached-recent', message_id: MSG, created_at: iso(30 * 24 * H) },
      { id: 'attached-expired', message_id: MSG, created_at: iso(91 * 24 * H) },
    ];
    for (const r of rows) {
      const path = `${BOT}/x/${r.id}.webp`;
      tables.widget_shots.push({ ...r, bot_id: BOT, storage_path: path });
      storage.objects.set(path, new Uint8Array(1));
    }
    const { cleanupShots } = await import('@/lib/widget/shots');
    const res = await cleanupShots(now);
    expect(res).toEqual({ orphans: 1, expired: 1, failed: false });
    expect(tables.widget_shots.map((r) => r.id).sort()).toEqual(['attached-recent', 'fresh-orphan']);
    expect(storage.objects.size).toBe(2);
  });

  it('객체 삭제가 실패하면 행을 남긴다(경로를 잃지 않게)', async () => {
    const now = Date.now();
    tables.widget_shots.push({ id: 'o', bot_id: BOT, message_id: null, storage_path: 'p', created_at: new Date(now - 48 * 3_600_000).toISOString() });
    storage.failRemove = true;
    const { cleanupShots } = await import('@/lib/widget/shots');
    const res = await cleanupShots(now);
    expect(res.failed).toBe(true);
    expect(tables.widget_shots).toHaveLength(1);
  });
});

describe('loadRunPickedShots — 수정안 근거 칸 (코드 리뷰 M4)', () => {
  const SHOT_MSG = '88888888-8888-4888-8888-888888888888';
  const PLAIN_MSG = '99999999-9999-4999-8999-999999999999';
  const OTHER_MSG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  function seed() {
    const t = (shot?: string) => ({ viewport: '1280x800', target: { kind: '버튼', tag: 'button', selector: 'b', text: '쿠폰 받기', rect: { x: 1, y: 2, w: 3, h: 4 }, ...(shot ? { shot } : {}) } });
    tables.insights.push(
      { id: 'i1', bot_id: BOT, group_id: 'g1', message_id: PLAIN_MSG, source_message_ids: [SHOT_MSG] },
      { id: 'i2', bot_id: OTHER_BOT, group_id: 'g1', message_id: OTHER_MSG, source_message_ids: [] },
    );
    tables.messages.push(
      { id: PLAIN_MSG, bot_id: BOT, context: t(), detected_at: '2026-09-25T00:00:00Z' },
      { id: SHOT_MSG, bot_id: BOT, context: t('s'), detected_at: '2026-09-25T00:01:00Z' },
      { id: OTHER_MSG, bot_id: OTHER_BOT, context: t('s'), detected_at: '2026-09-25T00:02:00Z' },
    );
    tables.widget_shots.push(
      { id: 's1', bot_id: BOT, message_id: SHOT_MSG, storage_path: `${BOT}/x/s1.webp`, width: 1280, height: 800 },
      { id: 's2', bot_id: OTHER_BOT, message_id: OTHER_MSG, storage_path: `${OTHER_BOT}/x/s2.webp`, width: 1280, height: 800 },
    );
  }

  it('묶음의 제보(보충 턴 포함)에서 짚은 것을, 찍은 화면이 있는 것 먼저 — 다른 봇 것은 섞이지 않는다', async () => {
    seed();
    const { loadRunPickedShots } = await import('@/lib/widget/shots');
    const out = await loadRunPickedShots({ botId: BOT, groupId: 'g1', insightId: null });
    expect(out).toHaveLength(2);
    expect(out[0].shot?.url).toContain(`${BOT}/x/s1.webp`);
    expect(out[1].shot).toBeNull();
    expect(out[0].label).toBe('「쿠폰 받기」 버튼');
    expect(JSON.stringify(out)).not.toContain('s2.webp');
  });

  it('인사이트 하나짜리 실행, 근거가 없으면 빈 배열', async () => {
    seed();
    const { loadRunPickedShots } = await import('@/lib/widget/shots');
    expect(await loadRunPickedShots({ botId: BOT, groupId: null, insightId: 'i1' })).toHaveLength(2);
    expect(await loadRunPickedShots({ botId: BOT, groupId: null, insightId: null })).toEqual([]);
  });
});
