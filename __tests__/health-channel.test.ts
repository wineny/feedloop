import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// /api/health 는 심사 기간(9/21~10/5) keep-alive 이자 배포 확인(commit) 창구다.
// 그래서 여기에 무엇을 «어디에» 싣느냐가 기능이다 — config 안에 숫자를 넣으면
// 값이 0 인 정상 상태가 falsy 로 읽혀 503 이 되고, 그 순간 이 창구가 상시 degraded 로
// 굳어 진짜 파손을 못 알아본다. 이 파일은 그 실수를 회귀로 잡는다.

const h = vi.hoisted(() => ({
  // 쿼리마다 돌려줄 count. null 을 넣으면 그 조회가 던진다.
  counts: {
    bots: 0 as number | null,
    configured: 0 as number | null,
    undelivered: 0 as number | null,
    lastError: 0 as number | null,
  },
  /** readChannelStats 의 미전달 조회에 실제로 걸린 필터. */
  undeliveredFilters: [] as { op: string; args: unknown[] }[],
  keyUsable: true,
}));

vi.mock('@/lib/utils/crypto', () => ({ isKeyUsable: () => h.keyUsable }));

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from(table: string) {
      const filters: { op: string; args: unknown[] }[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {};
      for (const op of ['select', 'eq', 'is', 'not', 'in']) {
        chain[op] = (...args: unknown[]) => {
          if (op !== 'select') filters.push({ op, args });
          return chain;
        };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chain.then = (resolve: any, reject: any) => {
        let key: keyof typeof h.counts;
        if (table === 'responses') {
          h.undeliveredFilters = filters;
          key = 'undelivered';
        } else if (filters.some((f) => f.args[0] === 'channel_access_key_encrypted')) {
          key = 'configured';
        } else if (filters.some((f) => f.args[0] === 'channel_last_error_at')) {
          key = 'lastError';
        } else {
          key = 'bots';
        }

        const count = h.counts[key];
        if (count === null) return Promise.reject(new Error('boom')).then(resolve, reject);
        return Promise.resolve({ count, error: null }).then(resolve, reject);
      };
      return chain;
    },
  }),
}));

// 라우트의 `config` 에 든 키 전부. 하나라도 빠지면 `configOk` 가 false 가 되어 **모든**
// 단언이 503 으로 무너진다 — 이 파일이 재려는 건 채널톡 숫자이지 env 가 아니다.
// `config` 에 키를 더하면 여기도 더해야 한다.
const CONFIG_ENV = [
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'GOOGLE_API_KEY',
  'NEXTAUTH_SECRET',
  'OPENAI_API_KEY',
  'POSTMARK_SERVER_TOKEN',
  'SUPABASE_SERVICE_ROLE_KEY',
];

beforeEach(() => {
  vi.resetModules();
  h.counts = { bots: 0, configured: 0, undelivered: 0, lastError: 0 };
  h.undeliveredFilters = [];
  h.keyUsable = true;
  for (const k of CONFIG_ENV) process.env[k] = 'set';
});

async function getHealth() {
  const { GET } = await import('@/app/api/health/route');
  const res = await GET();
  return { status: res.status, body: await res.json() };
}

describe('/api/health — channel 은 config 밖 최상위 키다', () => {
  it('channel 이 최상위에 있고 config 에는 channel_* 키가 없다', async () => {
    const { body } = await getHealth();

    expect(body.channel).toEqual({ configured_bots: 0, undelivered: 0, last_error_bots: 0 });
    expect(Object.keys(body.config).filter((k) => k.startsWith('channel'))).toEqual([]);
  });

  it('세 값이 전부 0 이어도 200 — 0 은 정상 상태다', async () => {
    // config 안에 넣었다면 every(Boolean) 이 0 을 falsy 로 읽어 여기서 503 이 났다.
    const { status, body } = await getHealth();

    expect(status).toBe(200);
    expect(body.status).toBe('ok');
  });

  it('undelivered 가 쌓여도 200 — 전송이 밀린 것과 서비스가 죽은 것은 다르다', async () => {
    h.counts = { bots: 0, configured: 2, undelivered: 7, lastError: 1 };

    const { status, body } = await getHealth();

    expect(status).toBe(200);
    expect(body.channel).toEqual({ configured_bots: 2, undelivered: 7, last_error_bots: 1 });
  });

  it('미전달 조회는 채널톡 대화로 좁힌다 — 카카오 대기열을 장애로 세지 않는다', async () => {
    await getHealth();

    const args = h.undeliveredFilters.map((f) => f.args);
    expect(args).toContainEqual(['response_type', 'loop_closed']);
    expect(args).toContainEqual(['delivered_at', null]);
    expect(args).toContainEqual(['conversations.source', 'channel']);
  });

  it('관측 조회가 실패해도 503 으로 만들지 않고 channel 을 null 로 둔다', async () => {
    h.counts.configured = null;

    const { status, body } = await getHealth();

    expect(status).toBe(200);
    expect(body.channel).toBeNull();
  });

  it('진짜 파손은 여전히 503 이다 — 관측 키가 판정을 무디게 만들지 않는다', async () => {
    h.keyUsable = false;

    const { status, body } = await getHealth();

    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.channel).not.toBeNull();
  });
});


afterEach(() => vi.unstubAllEnvs());

describe('/api/health — deployment commit', () => {
  it.each([
    ['123456789abcdef', 'abcdef123456789', '1234567'],
    ['', 'abcdef123456789', 'abcdef1'],
    [undefined, 'abcdef123456789', 'abcdef1'],
    ['', '', 'local'],
    [undefined, undefined, 'local'],
  ])('Vercel SHA %s, app SHA %s -> %s', async (vercelSha, appSha, expected) => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', vercelSha);
    vi.stubEnv('APP_COMMIT_SHA', appSha);
    expect((await getHealth()).body.commit).toBe(expected);
  });
});
