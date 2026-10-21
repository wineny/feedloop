import { describe, it, expect, vi, beforeEach } from 'vitest';

// 넷(pr · merge · close · verify) 다 같은 접근 규칙이다 — 세션 → 내 봇 → 그 봇의 run → 봇 행의 레포.
// 머지·닫기는 플랫폼 공용 GITHUB_TOKEN 으로 남의 레포에 «쓰기»가 가는 경로라, 무인증 401 ·
// 남의 봇 404 · 열린 PR 이 아니면 409 를 라우트 단위로 고정한다. GitHub 호출은 전부 모킹.

const {
  rpc, resolveOwnedBots, runRow, updated, getPrReview, reviewAndPromoteDraft, mergePr, closePr, commentOnPr, closeLoopForRun, verifyUnverifiedItem,
} = vi.hoisted(() => ({
  rpc: vi.fn(),
  resolveOwnedBots: vi.fn(),
  runRow: { current: null as Record<string, unknown> | null },
  updated: [] as { table: string; patch: Record<string, unknown> }[],
  getPrReview: vi.fn(),
  reviewAndPromoteDraft: vi.fn(),
  mergePr: vi.fn(),
  closePr: vi.fn(),
  commentOnPr: vi.fn(async () => true),
  closeLoopForRun: vi.fn(),
  verifyUnverifiedItem: vi.fn(),
}));

vi.mock('@/lib/auth/ownership', () => ({ resolveOwnedBots }));
vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    rpc,
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is']) chain[m] = vi.fn(() => chain);
      chain.maybeSingle = vi.fn(async () => ({ data: runRow.current, error: null }));
      chain.single = vi.fn(async () => ({ data: { id: 'x', closed_at: 'now', close_reason: 'duplicate', close_note: null }, error: null }));
      chain.update = vi.fn((patch: Record<string, unknown>) => {
        updated.push({ table, patch });
        return chain;
      });
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: [{ id: 'run-1' }], error: null });
      return chain;
    },
  }),
}));
vi.mock('@/lib/auto-dev/pr-review', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auto-dev/pr-review')>();
  return { ...actual, getPrReview, mergePr, closePr, commentOnPr };
});
vi.mock('@/lib/auto-dev/loop-closed', () => ({ closeLoopForRun }));
vi.mock('@/lib/auto-dev/draft-promotion', () => ({ reviewAndPromoteDraft }));
vi.mock('@/lib/auto-dev/verify-item', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auto-dev/verify-item')>();
  return { ...actual, verifyUnverifiedItem };
});

const BOT = 'bot-1';
const RUN_ID = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
const OPEN_RUN = {
  id: RUN_ID, bot_id: BOT, status: 'completed', pr_url: 'https://github.com/o/r/pull/8', pr_number: 8,
  merged_at: null, closed_at: null, group_id: 'g1', insight_id: null,
  explanation: {
    problem: 'p', change: 'c', effect: 'e', source: 'model',
    unverified: [
      { text: '파일 못 봄', verifiableBy: 'code', files: ['app/lib/identity.ts'], question: null, verdict: null },
      { text: '데이터 문제', verifiableBy: 'reporter', files: [], question: 'q', verdict: null },
    ],
  },
  files_changed: [{ path: 'a.ts', action: 'modified' }],
  insight_groups: { title: '쿠폰함 오류' }, insights: null, bots: { github_repo_url: 'https://github.com/o/r' },
};
const REVIEW_OK = {
  draft: false, draftGate: 'not_draft', createdAt: '2026-10-09T00:00:00Z',
  number: 8, url: 'u', state: 'open', merged: false, mergeable: true, mergeableState: 'clean',
  headRef: 'fix/x', headSha: 'sha', headRepo: 'o/r', baseRef: 'main', additions: 1, deletions: 1, changedFiles: 1,
  files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b', patchTruncated: false }],
  filesTruncated: false, preview: { url: 'https://x.vercel.app', state: 'ready' },
  build: { state: 'success', description: 'ok', targetUrl: null, updatedAt: null }, body: '본문',
};

const params = { params: Promise.resolve({ id: RUN_ID }) };
const post = (body?: unknown) =>
  new Request('https://feedloop.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  updated.length = 0;
  runRow.current = structuredClone(OPEN_RUN);
  rpc.mockImplementation(async (_name, args) => {
    const explanation = runRow.current!.explanation as typeof OPEN_RUN.explanation;
    const item = explanation.unverified[args.p_index];
    if (!item || item.verdict || JSON.stringify(item) !== JSON.stringify(args.p_expected_item)) return { data: null, error: null };
    item.verdict = args.p_verdict;
    return { data: structuredClone(explanation), error: null };
  });
  resolveOwnedBots.mockResolvedValue({ ok: true, userId: 'u1', botIds: [BOT] });
  getPrReview.mockResolvedValue(structuredClone(REVIEW_OK));
  reviewAndPromoteDraft.mockImplementation((...args) => getPrReview(...args));
  mergePr.mockResolvedValue({ sha: 'merged-sha', method: 'squash', branchDeleted: true });
  closePr.mockResolvedValue({ branchDeleted: true });
  closeLoopForRun.mockResolvedValue({ runId: RUN_ID, prNumber: 8, merged: true, closed: false, delivered: 2, skipped: 0, emailed: 1 });
  verifyUnverifiedItem.mockResolvedValue({ status: 'fix_does_not_hold', text: '경로 없음', checkedAt: 'now', files: ['app/lib/identity.ts'] });
});

async function routes() {
  return {
    pr: (await import('@/app/api/auto-dev/runs/[id]/pr/route')).GET,
    merge: (await import('@/app/api/auto-dev/runs/[id]/merge/route')).POST,
    close: (await import('@/app/api/auto-dev/runs/[id]/close/route')).POST,
    verify: (await import('@/app/api/auto-dev/runs/[id]/verify/route')).POST,
  };
}

describe('접근 — 넷이 같다', () => {
  it('무인증 401', async () => {
    resolveOwnedBots.mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });
    const r = await routes();
    expect((await r.pr(new Request('https://x'), params)).status).toBe(401);
    expect((await r.merge(post(), params)).status).toBe(401);
    expect((await r.close(post({ close_reason: 'duplicate' }), params)).status).toBe(401);
    expect((await r.verify(post({ index: 0 }), params)).status).toBe(401);
    expect(mergePr).not.toHaveBeenCalled();
    expect(closePr).not.toHaveBeenCalled();
  });

  it('남의 봇 run 은 404 — 존재를 알려주지 않는다, GitHub 호출 0', async () => {
    resolveOwnedBots.mockResolvedValue({ ok: true, userId: 'u2', botIds: ['other-bot'] });
    const r = await routes();
    expect((await r.pr(new Request('https://x'), params)).status).toBe(404);
    expect((await r.merge(post(), params)).status).toBe(404);
    expect((await r.close(post({ close_reason: 'duplicate' }), params)).status).toBe(404);
    expect((await r.verify(post({ index: 0 }), params)).status).toBe(404);
    expect(getPrReview).not.toHaveBeenCalled();
    expect(mergePr).not.toHaveBeenCalled();
  });

  it('다른 사이트 Origin 의 상태 변경 POST 는 403 — 본문 없는 POST 한 번이 머지·통지를 일으킨다', async () => {
    const r = await routes();
    const foreign = new Request('https://feedloop.test/x', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"close_reason":"duplicate"}' });
    expect((await r.merge(foreign, params)).status).toBe(403);
    expect((await r.close(foreign, params)).status).toBe(403);
    expect(mergePr).not.toHaveBeenCalled();
    expect(closePr).not.toHaveBeenCalled();
    // 같은 호스트면 통과
    const same = new Request('https://feedloop.test/x', { method: 'POST', headers: { origin: 'https://feedloop.test' } });
    expect((await r.merge(same, params)).status).toBe(200);
  });

  it('UUID 가 아닌 run id 는 404 — DB 오류(22P02)를 500 으로 흘리지 않는다', async () => {
    const r = await routes();
    const bad = { params: Promise.resolve({ id: 'not-a-uuid' }) };
    // 위 모킹은 uuid 검사 전에 못 이르므로 loadOwnedRun 이 먼저 404 를 내야 한다 — maybeSingle 이 호출되면 실패
    expect((await r.pr(new Request('https://x'), bad)).status).toBe(404);
    expect((await r.merge(post(), bad)).status).toBe(404);
  });

  it('레포 URL 은 DB 에서만(pr_url → 봇 행) — 요청이 무엇을 보내든 그 레포로 간다', async () => {
    const r = await routes();
    await r.merge(post({ repoUrl: 'https://github.com/evil/repo' }), params);
    // B5: 넷째 인자 = 봇 토큰 기준. run 의 bot_id 가 그대로 간다
    expect(mergePr).toHaveBeenCalledWith('https://github.com/o/r', 8, expect.anything(), { botId: BOT });
    // 네 라우트의 입구인 getPrReview 도 봇 토큰 기준을 받는다
    expect(getPrReview).toHaveBeenCalledWith('https://github.com/o/r', 8, { botId: BOT, allowUnavailableForMerge: true });
    // 봇 레포가 나중에 바뀌어도 PR 이 열린 레포(pr_url)로 간다 — 널널투어 봇 데모→라이브 전환 뒤 옛 PR 이 404 였다
    runRow.current = { ...structuredClone(OPEN_RUN), bots: { github_repo_url: 'https://github.com/o/moved' } };
    await r.merge(post(), params);
    expect(mergePr).toHaveBeenLastCalledWith('https://github.com/o/r', 8, expect.anything(), { botId: BOT });
  });
});

describe('GET /pr', () => {
  it.each(['write_failed', 'gate_failed'])('게이트 %s여도 diff와 빌드 상태를 200으로 반환한다', async reason => {
    reviewAndPromoteDraft.mockResolvedValue({ ...structuredClone(REVIEW_OK), draft: true, draftGate: 'waiting', draftGateBlocked: reason });
    const r = await routes();
    const response = await r.pr(new Request('https://x'), params);
    expect(response.status).toBe(200);
    expect((await response.json()).review).toMatchObject({ draft: true, draftGate: 'waiting', draftGateBlocked: reason, files: REVIEW_OK.files, build: REVIEW_OK.build });
  });
  it('실제 잠금 RPC가 없어도 상세 조회는 200이고 실제 초안 상태를 돌려준다', async () => {
    const actual = await vi.importActual<typeof import('@/lib/auto-dev/draft-promotion')>('@/lib/auto-dev/draft-promotion');
    reviewAndPromoteDraft.mockImplementation(actual.reviewAndPromoteDraft);
    getPrReview.mockResolvedValue({ ...structuredClone(REVIEW_OK), draft: true, draftGate: 'waiting', body: '## 자동 검사 대기' });
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find function claim_draft_pr_gate' } });
    const r = await routes();
    const response = await r.pr(new Request('https://x'), params);
    expect(response.status).toBe(200);
    expect((await response.json()).review).toMatchObject({ draft: true, draftGate: 'waiting', draftGateBlocked: 'lock_unavailable' });
    expect(mergePr).not.toHaveBeenCalled();
  });
  it('리뷰 + 차단 사유 + (설명 없을 때만) PR 본문에서 뽑은 설명. 본문 원문은 내보내지 않는다', async () => {
    const r = await routes();
    const res = await r.pr(new Request('https://x'), params);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.review.files[0].patch).toContain('+b');
    expect(json.review.body).toBeUndefined();
    expect(json.review.draft).toBe(false);
    expect(json.review.draftGate).toBe('not_draft');
    expect(reviewAndPromoteDraft).toHaveBeenCalledWith('https://github.com/o/r', 8, { botId: BOT });
    expect(json.blockedBy).toBeNull();
    expect(json.legacyExplanation).toBeNull(); // run 에 설명이 있다
  });

  it('설명 없는 옛 실행이면 PR 본문에서 뽑는다', async () => {
    runRow.current = { ...structuredClone(OPEN_RUN), explanation: null };
    getPrReview.mockResolvedValue({ ...structuredClone(REVIEW_OK), body: '머리말\n\n## 원인 분석\n\n원인' });
    const r = await routes();
    const json = await (await r.pr(new Request('https://x'), params)).json();
    expect(json.legacyExplanation).toMatchObject({ source: 'pr_body', problem: '원인', change: '머리말' });
  });

  it('PR 없는 실행 409', async () => {
    runRow.current = { ...structuredClone(OPEN_RUN), pr_url: null, pr_number: null };
    const r = await routes();
    expect((await r.pr(new Request('https://x'), params)).status).toBe(409);
  });
});

describe('POST /merge', () => {
  it.each(['write_failed', 'gate_failed', 'manual_draft'])('게이트 %s는 명시적 이유와 409로 반영을 막는다', async reason => {
    reviewAndPromoteDraft.mockResolvedValue({ ...structuredClone(REVIEW_OK), draft: true, draftGate: 'waiting', draftGateBlocked: reason });
    const r = await routes();
    const response = await r.merge(post(), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ blockedBy: 'draft_waiting', reason });
    expect(mergePr).not.toHaveBeenCalled();
  });

  it('ready PR은 검사 조회 불가여도 담당자 판단으로 반영한다', async () => {
    reviewAndPromoteDraft.mockResolvedValue({ ...structuredClone(REVIEW_OK), build: { ...REVIEW_OK.build, state: 'unknown', unavailable: true } });
    const r = await routes();
    const response = await r.merge(post(), params);
    expect(response.status).toBe(200);
    expect(mergePr).toHaveBeenCalledTimes(1);
  });
  it('담당자 반영 요청만 조회 불가 초안의 승격을 허용하고 이후 머지한다', async () => {
    reviewAndPromoteDraft.mockResolvedValue({ ...structuredClone(REVIEW_OK), draft: false, draftGate: 'promoted', build: { ...REVIEW_OK.build, state: 'unknown', unavailable: true } });
    const r = await routes();
    const response = await r.merge(post(), params);
    expect(response.status).toBe(200);
    expect(reviewAndPromoteDraft).toHaveBeenCalledWith('https://github.com/o/r', 8, { botId: BOT, allowUnavailableForMerge: true });
    expect(reviewAndPromoteDraft.mock.invocationCallOrder[0]).toBeLessThan(mergePr.mock.invocationCallOrder[0]);
  });
  it.each(['failure', 'pending'])('조회 불가와 함께 알려진 %s가 있으면 계속 반영 차단', async state => {
    reviewAndPromoteDraft.mockResolvedValue({ ...structuredClone(REVIEW_OK), draft: true, draftGateBlocked: 'checks_unavailable', build: { ...REVIEW_OK.build, state, unavailable: true } });
    const r = await routes();
    const response = await r.merge(post(), params);
    expect(response.status).toBe(409);
    expect((await response.json()).blockedBy).toBe(state === 'failure' ? 'build_failed' : 'build_pending');
    expect(mergePr).not.toHaveBeenCalled();
  });

  it('승격 후 댓글 쓰기가 실패해 ready 상태여도 해당 머지 요청은 차단한다', async () => {
    reviewAndPromoteDraft.mockResolvedValue({ ...structuredClone(REVIEW_OK), draft: false, draftGate: 'promoted', draftGateBlocked: 'write_failed' });
    const r = await routes();
    expect((await r.merge(post(), params)).status).toBe(409);
    expect(mergePr).not.toHaveBeenCalled();
  });
  it('실제 잠금 RPC가 실패하면 409로 이유를 말하고 머지하지 않는다', async () => {
    const actual = await vi.importActual<typeof import('@/lib/auto-dev/draft-promotion')>('@/lib/auto-dev/draft-promotion');
    reviewAndPromoteDraft.mockImplementation(actual.reviewAndPromoteDraft);
    getPrReview.mockResolvedValue({ ...structuredClone(REVIEW_OK), draft: true, draftGate: 'waiting', body: '## 자동 검사 대기' });
    rpc.mockRejectedValue(new Error('database offline'));
    const r = await routes();
    const response = await r.merge(post(), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ blockedBy: 'draft_waiting', reason: 'lock_unavailable', error: expect.stringContaining('lock') });
    expect(mergePr).not.toHaveBeenCalled();
  });
  it('초안은 승격 판정 이후에만 머지하고, 승격 전이면 409', async () => {
    reviewAndPromoteDraft.mockResolvedValue({ ...structuredClone(REVIEW_OK), draft: true, draftGate: 'waiting', build: { ...REVIEW_OK.build, state: 'unknown' } });
    const r = await routes();
    const waiting = await r.merge(post(), params);
    expect(waiting.status).toBe(409);
    expect((await waiting.json()).blockedBy).toBe('draft_waiting');
    expect(mergePr).not.toHaveBeenCalled();
    reviewAndPromoteDraft.mockResolvedValue({ ...structuredClone(REVIEW_OK), draft: false, draftGate: 'promoted' });
    expect((await r.merge(post(), params)).status).toBe(200);
    expect(reviewAndPromoteDraft.mock.invocationCallOrder.at(-1)).toBeLessThan(mergePr.mock.invocationCallOrder[0]);
  });

  it('승격 실패 시 머지하지 않는다', async () => {
    reviewAndPromoteDraft.mockRejectedValue(new Error('GraphQL denied'));
    const r = await routes();
    expect((await r.merge(post(), params)).status).toBe(502);
    expect(mergePr).not.toHaveBeenCalled();
  });
  it('squash 머지 → merged_at → 묶음 merged → 되돌림(closeLoopForRun) 한 번에', async () => {
    const r = await routes();
    const res = await r.merge(post(), params);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ merged: true, mergeMethod: 'squash', delivered: 2, emailed: 1 });
    expect(mergePr).toHaveBeenCalledWith('https://github.com/o/r', 8, expect.objectContaining({ expectedHeadSha: 'sha', title: '쿠폰함 오류 (#8)', headRef: 'fix/x', headRepo: 'o/r', baseRef: 'main' }), { botId: BOT });
    expect(updated.find((u) => u.table === 'auto_dev_runs')?.patch).toHaveProperty('merged_at');
    expect(updated.find((u) => u.table === 'insight_groups')?.patch).toEqual({ status: 'merged', follow_up_pending: true });
    expect(closeLoopForRun).toHaveBeenCalledWith(expect.objectContaining({ id: RUN_ID, merged_at: expect.any(String), title: '쿠폰함 오류' }));
  });

  it('빌드 실패·진행 중·충돌이면 409 — 서버가 다시 본다', async () => {
    const r = await routes();
    for (const [build, code] of [['failure', 'build_failed'], ['pending', 'build_pending']] as const) {
      getPrReview.mockResolvedValue({ ...structuredClone(REVIEW_OK), build: { ...REVIEW_OK.build, state: build } });
      const res = await r.merge(post(), params);
      expect(res.status).toBe(409);
      expect((await res.json()).blockedBy).toBe(code);
    }
    getPrReview.mockResolvedValue({ ...structuredClone(REVIEW_OK), mergeable: false });
    expect((await r.merge(post(), params)).status).toBe(409);
    expect(mergePr).not.toHaveBeenCalled();
  });

  it('빌드 unknown(Vercel 미연결)은 막지 않는다', async () => {
    getPrReview.mockResolvedValue({ ...structuredClone(REVIEW_OK), build: { ...REVIEW_OK.build, state: 'unknown' } });
    const r = await routes();
    expect((await r.merge(post(), params)).status).toBe(200);
  });

  it('이미 반영·닫힌 run 은 409, GitHub 호출 없이', async () => {
    const r = await routes();
    runRow.current = { ...structuredClone(OPEN_RUN), merged_at: 'x' };
    expect((await r.merge(post(), params)).status).toBe(409);
    runRow.current = { ...structuredClone(OPEN_RUN), closed_at: 'x' };
    expect((await r.merge(post(), params)).status).toBe(409);
    expect(getPrReview).not.toHaveBeenCalled();
  });

  it('GitHub 에서 이미 머지돼 있으면 DB 를 맞추고 409', async () => {
    getPrReview.mockResolvedValue({ ...structuredClone(REVIEW_OK), merged: true, state: 'closed' });
    const r = await routes();
    const res = await r.merge(post(), params);
    expect(res.status).toBe(409);
    expect(closeLoopForRun).toHaveBeenCalledWith(expect.objectContaining({ merged_at: null }));
    expect(mergePr).not.toHaveBeenCalled();
  });

  it('머지 뒤 되돌림이 실패해도 머지 사실은 돌려준다 (크론이 다시 시도)', async () => {
    closeLoopForRun.mockRejectedValue(new Error('db down'));
    const r = await routes();
    const json = await (await r.merge(post(), params)).json();
    expect(json.merged).toBe(true);
    expect(json.loopError).toContain('Check for shipped fixes');
  });
});

describe('POST /close', () => {
  it('사유 필수 — 없으면 400, GitHub 호출 없이', async () => {
    const r = await routes();
    expect((await r.close(post({ close_reason: null }), params)).status).toBe(400);
    expect((await r.close(post({}), params)).status).toBe(400);
    expect((await r.close(post({ close_reason: 'nope' }), params)).status).toBe(400);
    expect(closePr).not.toHaveBeenCalled();
  });

  it('닫기 → closed_at + 사유 저장 → 묶음 pr_created → open', async () => {
    const r = await routes();
    const res = await r.close(post({ close_reason: 'duplicate', close_note: ' 메모 ' }), params);
    expect(res.status).toBe(200);
    expect(closePr).toHaveBeenCalledWith('https://github.com/o/r', 8, { headRef: 'fix/x', headRepo: 'o/r', baseRef: 'main' }, { botId: BOT });
    const run = updated.find((u) => u.table === 'auto_dev_runs')!.patch;
    expect(run).toMatchObject({ close_reason: 'duplicate', close_note: '메모' });
    expect(run.closed_at).toBeTruthy();
    expect(updated.find((u) => u.table === 'insight_groups')?.patch).toEqual({ status: 'open' });
  });

  it('GitHub 에서 이미 닫혀 있으면 닫기 호출 없이 사유만 저장', async () => {
    getPrReview.mockResolvedValue({ ...structuredClone(REVIEW_OK), state: 'closed' });
    const r = await routes();
    expect((await r.close(post({ close_reason: 'other' }), params)).status).toBe(200);
    expect(closePr).not.toHaveBeenCalled();
  });

  it('GitHub 에서 이미 머지돼 있으면 409', async () => {
    getPrReview.mockResolvedValue({ ...structuredClone(REVIEW_OK), merged: true, state: 'closed' });
    const r = await routes();
    expect((await r.close(post({ close_reason: 'other' }), params)).status).toBe(409);
    expect(closePr).not.toHaveBeenCalled();
  });
});

describe('POST /verify', () => {
  it('code 항목만 · 그 파일만 읽어 판정 → 같은 JSON 에 verdict → PR 댓글', async () => {
    const r = await routes();
    const res = await r.verify(post({ index: 0 }), params);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(verifyUnverifiedItem).toHaveBeenCalledWith(expect.objectContaining({
      repoUrl: 'https://github.com/o/r', headSha: 'sha',
      item: expect.objectContaining({ files: ['app/lib/identity.ts'] }),
    }));
    expect(json.explanation.unverified[0].verdict.status).toBe('fix_does_not_hold');
    expect(json.explanation.unverified[1].verdict).toBeNull();
    expect(rpc).toHaveBeenCalledWith('save_run_verdict', expect.objectContaining({ p_run_id: RUN_ID, p_index: 0 }));
    expect(updated).toEqual([]);
    expect(commentOnPr).toHaveBeenCalledWith('https://github.com/o/r', 8, expect.stringContaining('실제 실행 검증 결과가 아닙니다'), { botId: BOT });
  });

  it('reporter 항목·없는 index·이미 확인한 항목은 409, 잘못된 index 는 400', async () => {
    const r = await routes();
    expect((await r.verify(post({ index: 1 }), params)).status).toBe(409);
    expect((await r.verify(post({ index: 5 }), params)).status).toBe(409);
    expect((await r.verify(post({ index: -1 }), params)).status).toBe(400);
    expect((await r.verify(post({ index: 'a' }), params)).status).toBe(400);
    const done = structuredClone(OPEN_RUN);
    (done.explanation.unverified[0] as Record<string, unknown>).verdict = { status: 'fix_holds', text: 't', checkedAt: 'x', files: [] };
    runRow.current = done;
    expect((await r.verify(post({ index: 0 }), params)).status).toBe(409);
    expect(verifyUnverifiedItem).not.toHaveBeenCalled();
  });

  it('요청 본문의 다른 필드는 무시된다 — 무엇을 확인할지는 엔진이 적어 둔 것만', async () => {
    const r = await routes();
    await r.verify(post({ index: 0, files: ['/etc/passwd'], question: '아무거나' }), params);
    const call = verifyUnverifiedItem.mock.calls[0][0] as { item: { files: string[] } };
    expect(call.item.files).toEqual(['app/lib/identity.ts']);
  });
});

it('parallel distinct verdicts survive and only successful claimants comment', async () => {
 const current = structuredClone(OPEN_RUN);
 current.explanation.unverified[1] = { ...current.explanation.unverified[0], text: 'another code item' };
 runRow.current = current;
 const r = await routes();
 const results = await Promise.all([r.verify(post({ index: 0 }), params),r.verify(post({ index: 1 }), params)]);
 expect(results.map(r => r.status)).toEqual([200,200]);
 expect(current.explanation.unverified.every(i => i.verdict)).toBe(true);
 expect(commentOnPr).toHaveBeenCalledTimes(2);
 expect(verifyUnverifiedItem).toHaveBeenCalledTimes(2);
 expect(updated).toEqual([]);
 expect((await r.verify(post({ index: 0 }), params)).status).toBe(409);
 expect(commentOnPr).toHaveBeenCalledTimes(2);
});
