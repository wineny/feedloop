import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { pickGroupForAutoPr } from '@/lib/auto-dev/auto-pr';

const h = vi.hoisted(() => ({
  // 테스트마다 갈아끼우는 가짜 Supabase. `runGrouping` 이 실제로 무엇을 insert/update 했는지 기록한다.
  client: null as unknown as { from: (t: string) => unknown },
  callLlm: null as unknown as Mock<(config: unknown, system: string, user: string) => Promise<string>>,
  // B1 — 되돌림 «생성» 자체는 existing-match.test.ts 가 진짜 경로로 지킨다.
  // 여기서는 묶기가 «누구를, 어떤 상태로» 넘기는지만 본다.
  rejoins: [] as { botId: string; rejoined: { groupId: string; status: string }[] }[],
  rejoinResult: null as null | { attempted: number; delivered: number; skippedNoRun: number; skippedDeadline: number; failures: string[] },
}));

vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: () => h.client }));

// 묶기는 봇별 `callLlm` 을 탄다(main `4b6df21`, I-16) — 봇마다 키·모델이 다르기 때문이다.
// 그 전에는 `@google/generative-ai` 를 직접 불렀고, 채널톡 브랜치는 그 시절에 갈라져 나와
// 옛 모듈을 모킹하고 있었다. 옛 모듈을 모킹하면 아무것도 안 가로채고 실제 호출이 나간다.
vi.mock('@/lib/bot/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bot/core')>()),
  getBotConfigFromDB: vi.fn(async (botId: string) => ({ botId }) as never),
}));

vi.mock('@/lib/bot/handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bot/handler')>()),
  callLlm: (config: unknown, system: string, user: string) => h.callLlm(config, system, user),
}));

// 판단(`matchOutcome`)은 진짜를 쓰고, DB·GitHub·메일을 타는 되돌림 생성만 가로챈다.
vi.mock('@/lib/groups/existing-match', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/groups/existing-match')>()),
  closeLoopForRejoins: vi.fn(async (botId: string, rejoined: { groupId: string; status: string }[]) => {
    h.rejoins.push({ botId, rejoined });
    return h.rejoinResult ?? { attempted: 0, delivered: 0, skippedNoRun: 0, skippedDeadline: 0, failures: [] };
  }),
}));

type Mod = typeof import('@/lib/groups/grouping');
let mod: Mod;

beforeEach(async () => {
  vi.resetModules();
  h.rejoins = [];
  h.rejoinResult = null;
  process.env.GOOGLE_API_KEY = 'test-key';
  mod = await import('@/lib/groups/grouping');
});

const KNOWN = new Set(['i1', 'i2', 'i3']);

describe('validateGroups — 모델이 지어낸 id 를 막는다', () => {
  it('목록에 없는 id 는 버린다', () => {
    const out = mod.validateGroups(
      [{ title: 'A', summary: 's', category: 'bug', insight_ids: ['i1', 'made-up-id'] }],
      KNOWN,
    );
    expect(out).toHaveLength(1);
    expect(out[0].insight_ids).toEqual(['i1']);
  });

  it('전부 지어낸 id 면 그 묶음 자체를 버린다', () => {
    const out = mod.validateGroups(
      [{ title: 'A', summary: 's', category: 'bug', insight_ids: ['nope', 'nada'] }],
      KNOWN,
    );
    expect(out).toEqual([]);
  });

  it('한 인사이트가 두 묶음에 들어가지 않게 한다', () => {
    const out = mod.validateGroups(
      [
        { title: 'A', summary: 's', category: 'bug', insight_ids: ['i1', 'i2'] },
        { title: 'B', summary: 's', category: 'ux', insight_ids: ['i2', 'i3'] },
      ],
      KNOWN,
    );
    expect(out[0].insight_ids).toEqual(['i1', 'i2']);
    expect(out[1].insight_ids).toEqual(['i3']); // i2 는 이미 A 에 갔다
  });

  it('제목이 없거나 insight_ids 가 배열이 아니면 버린다', () => {
    const out = mod.validateGroups(
      [
        { title: '', summary: 's', category: 'bug', insight_ids: ['i1'] },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { title: 'B', summary: 's', category: 'bug', insight_ids: 'i2' as any },
        { title: 'C', summary: 's', category: 'bug', insight_ids: ['i3'] },
      ],
      KNOWN,
    );
    expect(out.map((g) => g.title)).toEqual(['C']);
  });

  it('summary·category 가 비면 안전한 기본값으로 채운다', () => {
    const out = mod.validateGroups(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [{ title: '제목만 있음', summary: '', category: '', insight_ids: ['i1'] } as any],
      KNOWN,
    );
    expect(out[0].summary).toBe('제목만 있음');
    expect(out[0].category).toBe('other');
  });

  it('혼자인 피드백도 1개짜리 묶음으로 살린다', () => {
    const out = mod.validateGroups(
      [{ title: '단독', summary: 's', category: 'cs', insight_ids: ['i3'] }],
      KNOWN,
    );
    expect(out).toHaveLength(1);
    expect(out[0].insight_ids).toEqual(['i3']);
  });
});

describe('buildGroupingPrompt', () => {
  it('id 와 요약을 모두 넣고, 지어내지 말라고 못박는다', () => {
    const prompt = mod.buildGroupingPrompt([
      { id: 'i1', category: 'bug', summary: '쿠폰이 안 눌림' },
      { id: 'i2', category: 'ux', summary: '다크모드 깨짐' },
    ]);

    expect(prompt).toContain('i1');
    expect(prompt).toContain('쿠폰이 안 눌림');
    expect(prompt).toContain('i2');
    expect(prompt).toContain('Never invent a new id');
    // 예시 id 도 실제 목록의 것을 써서 모델을 엉뚱한 형식으로 유도하지 않는다
    expect(prompt).toContain('"insight_ids": ["i1"]');
  });

  it('혼자인 피드백을 빠뜨리지 말라고 지시한다', () => {
    const prompt = mod.buildGroupingPrompt([{ id: 'i1', category: 'bug', summary: 'x' }]);
    expect(prompt).toContain('one-item group');
  });

  // I-11 — 같은 대화의 조각을 모델이 알아보게 대화 라벨을 싣는다.
  it('대화 id 가 있으면 앞 8자 라벨을, 없으면 줄 자체를 안 넣는다', () => {
    const prompt = mod.buildGroupingPrompt([
      { id: 'i1', category: 'bug', summary: 'a', conversation_id: '90fea505-aaaa-4bbb-8ccc-000000000000' },
      { id: 'i2', category: 'bug', summary: 'b', conversation_id: null },
      { id: 'i3', category: 'bug', summary: 'c' },
    ]);
    expect(prompt).toContain('conversation: #90fea505');
    expect(prompt).not.toContain('90fea505-aaaa'); // 전체 uuid 는 안 싣는다
    expect((prompt.match(/conversation: #/g) ?? []).length).toBe(1);
    expect(prompt).toContain('Reports from the same "conversation"');
  });

  it('conversationTag — 짧거나 없는 값은 null', () => {
    expect(mod.conversationTag(undefined)).toBeNull();
    expect(mod.conversationTag(null)).toBeNull();
    expect(mod.conversationTag('abc')).toBeNull();
    expect(mod.conversationTag('abcdefgh-1234')).toBe('#abcdefgh');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runGrouping — 채널톡의 「할 일 없는」 인사이트만 모델을 건너뛴다.
//
// 이 묶음이 지키는 것은 무회귀다. 웹·카카오는 분류가 무엇이든 종전대로 프롬프트로 가고,
// 그 동작이 한 줄이라도 바뀌면 기존 묶음이 대시보드에서 사라진다.
// ─────────────────────────────────────────────────────────────────────────────

const BOT = 'bot-1';
const BOT2 = 'bot-2';

/**
 * `runGrouping` 은 두 경로를 쓴다.
 *   ① 자동 닫힘 — 채널톡의 「할 일 없는」 인사이트를 테이블에서 직접 읽어 1건짜리
 *      `dismissed` 묶음으로 닫는다. 모델을 안 탄다.
 *   ② 묶기 — `pipeline_group_snapshot` / `pipeline_commit_groups` RPC.
 *      스냅샷은 **서버에서** `category IN ('bug','ux','feature_request')` 로 거르므로
 *      문의·칭찬은 여기 오지 않는다. ① 이 따로 있는 이유가 그것이다.
 */
interface SeedInsight {
  id: string;
  category: string;
  summary?: string;
  /** 인사이트가 달린 메시지의 입구. null 이면 `message_id` 가 없는 인사이트다. */
  source: string | null;
  /** 안 주면 BOT. 봇별 분리를 검사할 때만 쓴다. */
  botId?: string;
}

interface Recorded {
  /** `insight_groups` 에 들어간 행(= 자동 닫힘 묶음). */
  dismissInserts: Record<string, unknown>[];
  /** 자동 닫힘이 연결한 인사이트 id. */
  dismissLinks: string[];
  /** 호출된 RPC 이름과 인자. */
  rpc: { fn: string; args: Record<string, unknown> }[];
}

interface SnapshotSeed {
  insights?: { id: string; category: string; summary: string }[];
  existing?: { id: string; title: string; summary: string; category: string; status: string }[];
  pending?: number;
  revision?: number;
}

function installClient(
  seed: SeedInsight[],
  snapshots: Record<string, SnapshotSeed> = {},
  opts: { dismissQueryError?: string; commitError?: string } = {},
): Recorded {
  const rec: Recorded = { dismissInserts: [], dismissLinks: [], rpc: [] };
  let seq = 0;

  // 자동 닫힘 조회가 실제로 보는 행. 라우트가 `.not('category','in',…)` 로 좁히므로
  // 가짜도 **진짜로** 좁힌다 — 흉내만 내면 묶여야 할 bug 가 닫히는데도 초록이 된다.
  const rows = seed.map((x) => ({
    id: x.id,
    bot_id: x.botId ?? BOT,
    category: x.category,
    summary: x.summary ?? `${x.id} 요약`,
    message_id: x.source === null ? null : `m-${x.id}`,
    messages: x.source === null ? null : { source: x.source },
  }));

  h.client = {
    from(table: string) {
      const ctx: { botId?: string; excluded?: Set<string>; insert?: Record<string, unknown>; update?: Record<string, unknown>; id?: string } = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {};
      for (const m of ['select', 'is', 'order', 'limit']) chain[m] = () => chain;
      chain.eq = (col: string, value: string) => {
        if (col === 'bot_id') ctx.botId = value;
        if (col === 'id') ctx.id = value;
        return chain;
      };
      chain.not = (col: string, op: string, list: string) => {
        if (col === 'category' && op === 'in') {
          ctx.excluded = new Set(list.replace(/^\(|\)$/g, '').split(','));
        }
        return chain;
      };
      chain.insert = (v: Record<string, unknown>) => {
        ctx.insert = v;
        return chain;
      };
      chain.update = (v: Record<string, unknown>) => {
        ctx.update = v;
        return chain;
      };
      chain.single = () => chain;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chain.then = (resolve: any, reject: any) => {
        let value: unknown;
        if (table === 'insight_groups') {
          rec.dismissInserts.push(ctx.insert ?? {});
          value = { data: { id: `g${++seq}` }, error: null };
        } else if (ctx.update) {
          if (ctx.id) rec.dismissLinks.push(ctx.id);
          value = { error: null };
        } else if (opts.dismissQueryError) {
          value = { data: null, error: { message: opts.dismissQueryError } };
        } else {
          const visible = rows.filter(
            (r) =>
              (!ctx.botId || r.bot_id === ctx.botId) &&
              (!ctx.excluded || !ctx.excluded.has(r.category)),
          );
          value = { data: visible, error: null };
        }
        return Promise.resolve(value).then(resolve, reject);
      };
      return chain;
    },
    rpc(fn: string, args: Record<string, unknown>) {
      rec.rpc.push({ fn, args });
      if (fn === 'pipeline_group_snapshot') {
        const snap = snapshots[args.p_bot_id as string] ?? {};
        return Promise.resolve({
          data: {
            revision: snap.revision ?? 1,
            insights: snap.insights ?? [],
            existing: snap.existing ?? [],
            pending: snap.pending ?? (snap.insights ?? []).length,
          },
          error: null,
        });
      }
      if (opts.commitError) return Promise.resolve({ data: null, error: { message: opts.commitError } });
      const groups = (args.p_groups as { title: string; insight_ids: string[] }[]) ?? [];
      return Promise.resolve({
        data: {
          grouped: groups.reduce((n, g) => n + g.insight_ids.length, 0),
          groups: groups.map((g, i) => ({ id: `cg${i + 1}`, title: g.title, count: g.insight_ids.length })),
        },
        error: null,
      });
    },
  } as unknown as { from: (t: string) => unknown };

  return rec;
}

/** 모델이 「받은 것을 전부 한 묶음으로」 돌려주게 한다. */
function stubModelGroupsEverything() {
  h.callLlm = vi.fn(async (_config: unknown, _system: string, user: string) => {
    const ids = [...user.matchAll(/- id: (\S+)/g)].map((m) => m[1]);
    return JSON.stringify({
      groups: [{ title: '모델 묶음', summary: 's', category: 'bug', insight_ids: ids }],
    });
  });
}

/** 모델에 실제로 넘어간 인사이트 id 들(호출 전부 합산). */
function promptedIds(): string[] {
  return h.callLlm.mock.calls.flatMap((call) =>
    [...(call[2] as string).matchAll(/- id: (\S+)/g)].map((m) => m[1]),
  );
}

describe('runGrouping — 채널톡의 할 일 없는 제보는 모델 없이 닫는다', () => {
  beforeEach(() => stubModelGroupsEverything());

  it('채널톡 문의·칭찬만 있으면 모델을 한 번도 부르지 않는다', async () => {
    const rec = installClient([
      { id: 'c1', category: 'cs', source: 'channel' },
      { id: 'c2', category: 'praise', source: 'channel' },
    ]);

    const out = await mod.runGrouping([BOT]);

    expect(h.callLlm).not.toHaveBeenCalled();
    expect(out.dismissed).toBe(2);
    expect(rec.dismissInserts).toHaveLength(2);
    expect(rec.dismissInserts.every((g) => g.status === 'dismissed')).toBe(true);
    expect(rec.dismissLinks.sort()).toEqual(['c1', 'c2']);
    // 묶기 경로는 그래도 돈다 — 스냅샷이 비었을 뿐이다.
    expect(rec.rpc.map((c) => c.fn)).toEqual(['pipeline_group_snapshot']);
  });

  it('채널톡이라도 bug·ux 는 닫지 않는다 — 고칠 코드가 있다', async () => {
    // 스냅샷은 서버에서 거르므로, 여기 들어온다는 것 자체가 「묶을 것」이라는 뜻이다.
    const rec = installClient(
      [{ id: 'b1', category: 'bug', source: 'channel' }],
      { [BOT]: { insights: [{ id: 'b1', category: 'bug', summary: '쿠폰함 오류' }] } },
    );

    const out = await mod.runGrouping([BOT]);

    expect(out.dismissed).toBe(0);
    expect(rec.dismissInserts).toHaveLength(0);
    expect(promptedIds()).toEqual(['b1']);
    expect(rec.rpc.map((c) => c.fn)).toEqual(['pipeline_group_snapshot', 'pipeline_commit_groups']);
    expect(out.grouped).toBe(1);
  });

  it('웹·카카오의 문의는 닫지 않는다 — 운영자가 답해야 할 문의일 수 있다', async () => {
    const rec = installClient([
      { id: 'w1', category: 'cs', source: 'web' },
      { id: 'k1', category: 'praise', source: 'kakao' },
    ]);

    const out = await mod.runGrouping([BOT]);

    expect(out.dismissed).toBe(0);
    expect(rec.dismissInserts).toHaveLength(0);
  });

  it('입구를 모르는 인사이트(message_id 없음)는 채널톡으로 보지 않는다', async () => {
    const rec = installClient([{ id: 'n1', category: 'cs', source: null }]);

    const out = await mod.runGrouping([BOT]);

    expect(out.dismissed).toBe(0);
    expect(rec.dismissInserts).toHaveLength(0);
  });

  it('자동 닫힘이 실패해도 묶기는 계속한다 — 둘은 다른 사건이다', async () => {
    const rec = installClient(
      [{ id: 'b1', category: 'bug', source: 'web' }],
      { [BOT]: { insights: [{ id: 'b1', category: 'bug', summary: '오류' }] } },
      { dismissQueryError: 'insights table gone' },
    );

    const out = await mod.runGrouping([BOT]);

    expect(out.failures).toContainEqual(
      expect.objectContaining({ botId: BOT, reason: expect.stringContaining('auto_dismiss_lookup_failed') }),
    );
    // 묶기는 그대로 돌았다
    expect(out.grouped).toBe(1);
    expect(rec.rpc.map((c) => c.fn)).toContain('pipeline_commit_groups');
  });
});

describe('runGrouping — 봇마다 따로 돈다', () => {
  beforeEach(() => stubModelGroupsEverything());

  it('봇이 둘이면 스냅샷·모델·커밋도 봇마다 — 다른 서비스의 제보를 한 묶음에 엮지 않는다', async () => {
    const rec = installClient([], {
      [BOT]: { insights: [{ id: 'a1', category: 'bug', summary: 'A 오류' }] },
      [BOT2]: { insights: [{ id: 'b1', category: 'bug', summary: 'B 오류' }] },
    });

    await mod.runGrouping([BOT, BOT2]);

    expect(h.callLlm).toHaveBeenCalledTimes(2);
    const prompts = h.callLlm.mock.calls.map((c) => c[2] as string);
    expect(prompts.filter((p) => p.includes('a1') && !p.includes('b1'))).toHaveLength(1);
    expect(prompts.filter((p) => p.includes('b1') && !p.includes('a1'))).toHaveLength(1);

    const snapshots = rec.rpc.filter((c) => c.fn === 'pipeline_group_snapshot');
    expect(snapshots.map((c) => c.args.p_bot_id)).toEqual([BOT, BOT2]);
  });

  it('자동 닫힘 묶음은 pickGroupForAutoPr 후보에서 빠진다', async () => {
    // 크론이 「가장 큰 open 묶음」을 고르는데 닫아둔 문의가 후보로 남으면 고칠 게 없는
    // 묶음에 PR 을 연다(리허설 PR #4). dismissed 는 status 로 걸러진다.
    installClient([{ id: 'c1', category: 'cs', source: 'channel' }]);
    const out = await mod.runGrouping([BOT]);

    expect(out.dismissed).toBe(1);
    expect(
      pickGroupForAutoPr([
        {
          id: 'g1',
          status: 'dismissed',
          category: 'cs',
          insightCount: 9,
          hasRun: false,
          distinctConversations: 9,
          hasReachableContact: true,
        },
      ]),
    ).toBeNull();
  });

  it('자동 닫힘도 봇으로 좁힌다 — 남의 봇 제보를 닫지 않는다', async () => {
    const rec = installClient([
      { id: 'c1', category: 'cs', source: 'channel' },
      { id: 'c2', category: 'cs', source: 'channel', botId: BOT2 },
    ]);

    const out = await mod.runGrouping([BOT]);

    expect(out.dismissed).toBe(1);
    expect(rec.dismissLinks).toEqual(['c1']);
  });

  it('커밋이 실패한 봇만 failures 에 남고 다른 봇은 계속한다', async () => {
    installClient(
      [],
      { [BOT]: { insights: [{ id: 'a1', category: 'bug', summary: 'A' }] } },
      { commitError: 'stale_group_snapshot' },
    );

    const out = await mod.runGrouping([BOT]);

    expect(out.grouped).toBe(0);
    expect(out.failures).toContainEqual({ botId: BOT, reason: 'stale_group_snapshot' });
  });
});

describe('runGrouping — 기존 묶음 대조', () => {
  beforeEach(() => stubModelGroupsEverything());

  it('스냅샷의 기존 묶음이 프롬프트에 실린다 — 같은 문제를 새 묶음으로 또 만들지 않게', async () => {
    installClient([], {
      [BOT]: {
        insights: [{ id: 'a1', category: 'bug', summary: '쿠폰함 흰 화면' }],
        existing: [
          { id: 'old-1', title: '쿠폰함이 안 열림', summary: '기존 묶음', category: 'bug', status: 'merged' },
        ],
      },
    });

    await mod.runGrouping([BOT]);

    const prompt = h.callLlm.mock.calls[0][2] as string;
    expect(prompt).toContain('쿠폰함이 안 열림');
  });

  it('모델이 기존 묶음을 고르면 커밋에 그 id 가 실린다', async () => {
    const existing = [
      { id: 'old-1', title: '쿠폰함이 안 열림', summary: '기존', category: 'bug', status: 'merged' },
    ];
    const rec = installClient([], { [BOT]: { insights: [{ id: 'a1', category: 'bug', summary: '또 안 열림' }], existing } });
    h.callLlm = vi.fn(async () =>
      JSON.stringify({
        groups: [
          { existing_group_id: 'old-1', title: '쿠폰함이 안 열림', summary: 's', category: 'bug', insight_ids: ['a1'] },
        ],
      }),
    );

    await mod.runGrouping([BOT]);

    const commit = rec.rpc.find((c) => c.fn === 'pipeline_commit_groups');
    expect(commit).toBeDefined();
    expect((commit!.args.p_groups as { existing_group_id?: string }[])[0].existing_group_id).toBe('old-1');
  });

  /** 모델이 기존 묶음 하나를 고르게 한다. `claimed` 는 응답에 실을 id. */
  function stubModelPicks(claimed: string | null, field: 'existing_group_id' | 'matches_existing_group_id' = 'existing_group_id') {
    h.callLlm = vi.fn(async (_c: unknown, _s: string, user: string) => {
      const ids = [...user.matchAll(/- id: (\S+)/g)].map((m) => m[1]);
      return JSON.stringify({
        groups: [{ ...(claimed ? { [field]: claimed } : {}), title: '같은 문제', summary: 's', category: 'bug', insight_ids: ids }],
      });
    });
  }

  const existingOf = (status: string) => [
    { id: 'old-1', title: '쿠폰함이 안 열림', summary: '기존', category: 'bug', status },
  ];
  const seed = (status: string) => ({
    [BOT]: { insights: [{ id: 'a1', category: 'bug', summary: '또 안 열림' }], existing: existingOf(status) },
  });
  const committedGroups = (rec: Recorded) =>
    (rec.rpc.find((c) => c.fn === 'pipeline_commit_groups')?.args.p_groups ?? []) as { existing_group_id?: string }[];

  it('프롬프트가 기존 묶음 목록 밖 id 를 쓰지 말라고 못박고 상태의 뜻을 알려준다', () => {
    const prompt = mod.buildGroupingPrompt(
      [{ id: 'a1', category: 'bug', summary: 'x' }],
      existingOf('merged'),
    );
    expect(prompt).toContain('Do not use an id that is not here');
    expect(prompt).toContain('pr_created');
    expect(prompt).toContain('"existing_group_id": null');
  });

  it('목록 밖 묶음 id 는 그 묶음을 통째로 버린다 — 어느 묶음인지 자체를 못 믿는다', async () => {
    const rec = installClient([], seed('open'));
    stubModelPicks('지어낸-묶음');

    const out = await mod.runGrouping([BOT]);

    expect(rec.rpc.map((c) => c.fn)).not.toContain('pipeline_commit_groups');
    expect(out.failures).toContainEqual({ botId: BOT, reason: 'invalid_or_omitted_proposals' });
  });

  it('matches_existing_group_id 라는 이름으로 답해도 같은 값으로 받는다', async () => {
    const rec = installClient([], seed('open'));
    stubModelPicks('old-1', 'matches_existing_group_id');

    await mod.runGrouping([BOT]);

    expect(committedGroups(rec)[0].existing_group_id).toBe('old-1');
  });

  it('닫힌(dismissed) 묶음에는 합류하지 않고 새 묶음으로 간다', async () => {
    const rec = installClient([], seed('dismissed'));
    stubModelPicks('old-1');

    const out = await mod.runGrouping([BOT]);

    const groups = committedGroups(rec);
    expect(groups).toHaveLength(1);
    expect(groups[0].existing_group_id).toBeUndefined();
    expect(out.grouped).toBe(1);
    expect(h.rejoins).toEqual([]);
  });

  it('머지된 묶음에 합류하면 「이미 반영됐어요」 되돌림을 그 자리에서 만든다', async () => {
    const rec = installClient([], seed('merged'));
    stubModelPicks('old-1');
    h.rejoinResult = { attempted: 1, delivered: 2, skippedNoRun: 0, skippedDeadline: 0, failures: [] };

    const out = await mod.runGrouping([BOT]);

    expect(committedGroups(rec)[0].existing_group_id).toBe('old-1');
    expect(h.rejoins).toEqual([{ botId: BOT, rejoined: [{ groupId: 'old-1', status: 'merged' }] }]);
    expect(out.loopClosed).toBe(2);
  });

  it('열린 묶음에는 합류만 한다 — 되돌림은 머지 때 함께 나간다', async () => {
    const rec = installClient([], seed('open'));
    stubModelPicks('old-1');

    const out = await mod.runGrouping([BOT]);

    expect(committedGroups(rec)[0].existing_group_id).toBe('old-1');
    expect(h.rejoins[0].rejoined).toEqual([{ groupId: 'old-1', status: 'open' }]);
    expect(out.loopClosed).toBe(0);
  });

  it('pr_created 묶음도 합류만 한다', async () => {
    installClient([], seed('pr_created'));
    stubModelPicks('old-1');

    const out = await mod.runGrouping([BOT]);

    expect(h.rejoins[0].rejoined).toEqual([{ groupId: 'old-1', status: 'pr_created' }]);
    expect(out.loopClosed).toBe(0);
  });

  // 코드 리뷰 HIGH — 되돌림 실패를 `failures` 에 넣었더니 ① auto-pr 이 묶음을 고르기 전에
  // 반환해 자동 PR 이 멎고 ② 자동 묶기가 재무장되는데 재실행은 이미 묶인 인사이트를 다시
  // 안 보므로 되돌림은 재시도되지 않았다. 그래서 «따로» 센다.
  it('되돌림이 실패해도 묶기 failures 는 비어 있다 — 자동 PR 을 멈추지 않는다', async () => {
    installClient([], seed('merged'));
    stubModelPicks('old-1');
    h.rejoinResult = { attempted: 1, delivered: 0, skippedNoRun: 0, skippedDeadline: 0, failures: ['loop_closed_failed(old-1): boom'] };

    const out = await mod.runGrouping([BOT]);

    expect(out.grouped).toBe(1); // 묶기 자체는 끝났다
    expect(out.failures).toEqual([]);
    expect(out.loopFailures).toContain('loop_closed_failed(old-1): boom');
  });

  it('상한·마감에 걸려 미룬 건수도 loopFailures 에 남는다 — 크론이 줍는다', async () => {
    installClient([], seed('merged'));
    stubModelPicks('old-1');
    h.rejoinResult = { attempted: 5, delivered: 5, skippedNoRun: 0, skippedDeadline: 3, failures: [] };

    const out = await mod.runGrouping([BOT]);

    expect(out.failures).toEqual([]);
    expect(out.loopFailures!.join(' ')).toContain('loop_closed_deferred: 3');
  });

  it('스냅샷이 30개를 넘겨도 프롬프트에는 최근 30개만 싣는다 — 마이그레이션 없이도', async () => {
    const many = Array.from({ length: 35 }, (_, i) => ({
      id: `old-${i}`, title: `묶음 ${i}`, summary: 's', category: 'bug', status: 'open',
    }));
    installClient([], { [BOT]: { insights: [{ id: 'a1', category: 'bug', summary: 'x' }], existing: many } });
    stubModelPicks(null);

    await mod.runGrouping([BOT]);

    const prompt = h.callLlm.mock.calls[0][2] as string;
    expect(prompt).not.toContain('"old-4"'); // 오래된 앞 5개는 잘린다
    expect(prompt).toContain('"old-5"');
    expect(prompt).toContain('"old-34"');
  });

  it('잘려나간 묶음의 id 는 합류 대상이 아니다 — 목록 밖 id 로 취급한다', async () => {
    const many = Array.from({ length: 35 }, (_, i) => ({
      id: `old-${i}`, title: `묶음 ${i}`, summary: 's', category: 'bug', status: 'open',
    }));
    const rec = installClient([], { [BOT]: { insights: [{ id: 'a1', category: 'bug', summary: 'x' }], existing: many } });
    stubModelPicks('old-0'); // 잘려나간 것

    const out = await mod.runGrouping([BOT]);

    expect(rec.rpc.map((c) => c.fn)).not.toContain('pipeline_commit_groups');
    expect(out.failures).toContainEqual({ botId: BOT, reason: 'invalid_or_omitted_proposals' });
  });

  it('합류가 없으면 되돌림 경로를 아예 부르지 않는다', async () => {
    installClient([], seed('open'));
    stubModelPicks(null);

    await mod.runGrouping([BOT]);

    expect(h.rejoins).toEqual([]);
  });
});
