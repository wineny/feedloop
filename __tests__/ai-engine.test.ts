import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock Octokit
const mockOctokit = {
  repos: {
    get: vi.fn(),
    getContent: vi.fn(),
    createOrUpdateFileContents: vi.fn(),
  },
  git: {
    getRef: vi.fn(),
    getTree: vi.fn(),
    getBlob: vi.fn(),
    createRef: vi.fn(),
  },
  pulls: {
    create: vi.fn(),
  },
};

const octokitAuths: string[] = [];
vi.mock('@octokit/rest', () => ({
  Octokit: function (opts: { auth: string }) { octokitAuths.push(opts.auth); return mockOctokit; },
}));

// B5 — 봇 토큰 우선·공용 폴백. 봇 행은 여기서 갈아끼운다
const { botTokenRow, failureRecords } = vi.hoisted(() => ({
  botTokenRow: { current: null as string | null },
  failureRecords: [] as Record<string, unknown>[],
}));
vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      let patch: Record<string, unknown> | null = null;
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.not = vi.fn(() => chain);
      chain.update = vi.fn((p: Record<string, unknown>) => { patch = p; return chain; });
      chain.maybeSingle = vi.fn(async () => ({ data: { github_token_encrypted: botTokenRow.current }, error: null }));
      chain.then = (resolve: (v: unknown) => void) => { if (patch) failureRecords.push(patch); resolve({ data: null, error: null }); };
      return chain;
    },
  }),
}));

// Set env before import
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.GITHUB_TOKEN = 'ghp_test';

/** 데모 레포처럼 소스가 src/ 가 아닌 곳에 있는 트리 */
const REPO_TREE = [
  { path: 'src', type: 'tree' },
  { path: 'src/lib/progress.ts', type: 'blob', sha: 'sha-progress', size: 400 },
  { path: 'src/lib/format.ts', type: 'blob', sha: 'sha-format', size: 200 },
  { path: 'README.md', type: 'blob', sha: 'sha-readme', size: 100 },
  { path: 'package-lock.json', type: 'blob', sha: 'sha-lock', size: 900_000 },
  { path: 'node_modules/left-pad/index.js', type: 'blob', sha: 'sha-nm', size: 100 },
  { path: '.next/static/chunk.js', type: 'blob', sha: 'sha-next', size: 100 },
  { path: 'public/logo.png', type: 'blob', sha: 'sha-png', size: 5000 },
  { path: 'src/lib/huge.ts', type: 'blob', sha: 'sha-huge', size: 500_000 },
];

const ORIGINAL_SOURCE = 'export function calc() { return 0; }';

describe('callAutoDev', () => {
  let mod: typeof import('@/lib/auto-dev/ai-engine');
  let callAutoDev: typeof import('@/lib/auto-dev/ai-engine').prepareCodeFix;

  const baseOptions = {
    repoUrl: 'https://github.com/user/repo',
    insight: {
      category: 'bug',
      summary: '완료율이 0%로 표시되는 버그',
      message_body: '실습 완료 후 DEVLOG 제출했는데 완료율이 0%입니다',
    },
  };

  const selectionJson = JSON.stringify({
    reason: '완료율 계산이 여기 있다',
    candidates: ['src/lib/progress.ts'],
  });

  const patchJson = JSON.stringify({
    analysis: '완료율 계산 로직에서 0으로 나누는 버그',
    files: [{ path: 'src/lib/progress.ts', action: 'modified', content: 'export function calc() { return 100; }' }],
    commit_message: 'fix: 완료율 계산 수정',
    pr_title: 'fix: 완료율이 0%로 표시되는 버그 수정',
    pr_body: '유저 피드백 기반 자동 수정',
  });

  function mockStreamResponse(text: string) {
    const chunks = [
      `data: {"type":"content_block_delta","delta":{"text":${JSON.stringify(text)}}}\n\n`,
      'data: [DONE]\n\n',
    ];
    let i = 0;
    const mockReader = {
      read: vi.fn().mockImplementation(async () => {
        if (i >= chunks.length) return { done: true, value: undefined };
        return { done: false, value: new TextEncoder().encode(chunks[i++]) };
      }),
    };
    mockFetch.mockResolvedValueOnce({ ok: true, body: { getReader: () => mockReader } });
  }

  /** 1-pass(선정) → 2-pass(수정안) 순서로 두 번 응답한다. */
  function mockBothPasses(selection = selectionJson, patch = patchJson) {
    mockStreamResponse(selection);
    mockStreamResponse(patch);
  }

  function mockGitHubAPIs() {
    mockOctokit.repos.get.mockResolvedValue({ data: { default_branch: 'main' } });
    mockOctokit.git.getRef.mockResolvedValue({ data: { object: { sha: 'abc123' } } });
    mockOctokit.git.getTree.mockResolvedValue({ data: { tree: REPO_TREE } });
    mockOctokit.git.createRef.mockResolvedValue({});
    mockOctokit.repos.getContent.mockResolvedValue({
      data: {
        type: 'file',
        sha: 'sha-progress',
        content: Buffer.from(ORIGINAL_SOURCE).toString('base64'),
      },
    });
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});
    mockOctokit.pulls.create.mockResolvedValue({
      data: { html_url: 'https://github.com/user/repo/pull/42', number: 42 },
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.GITHUB_TOKEN = 'ghp_test';
    vi.resetModules();
    mod = await import('@/lib/auto-dev/ai-engine');
    callAutoDev = mod.prepareCodeFix;
  });

  it('should throw if ANTHROPIC_API_KEY is not set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.resetModules();
    const fresh = await import('@/lib/auto-dev/ai-engine');
    mockGitHubAPIs();
    await expect(fresh.prepareCodeFix(baseOptions)).rejects.toThrow('ANTHROPIC_API_KEY');
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('should throw on non-ok API response', async () => {
    mockGitHubAPIs();
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });
    await expect(callAutoDev(baseOptions)).rejects.toThrow('Anthropic API error (401)');
  });

  it('should throw if response body is null', async () => {
    mockGitHubAPIs();
    mockFetch.mockResolvedValueOnce({ ok: true, body: null });
    await expect(callAutoDev(baseOptions)).rejects.toThrow('The response has no stream');
  });

  it('should throw if GITHUB_TOKEN is not set', async () => {
    delete process.env.GITHUB_TOKEN;
    vi.resetModules();
    const fresh = await import('@/lib/auto-dev/ai-engine');
    await expect(fresh.prepareCodeFix(baseOptions)).rejects.toThrow('GITHUB_TOKEN');
    process.env.GITHUB_TOKEN = 'ghp_test';
  });

  // 2026-09-14: 검증 프로필이 없다는 것만으로는 더 이상 멈추지 않는다(제보마다 손으로 쓰는
  // 것이라 그대로 두면 자동 PR 이 영영 꺼진다). 대신 «중복 발행을 막을 수단»이 없으면
  // 여전히 열기 전에 멈춘다 — 이 방어선은 완화 대상이 아니다.
  it('durable 발행 콜백이 없으면 생성·발행 전에 멈춘다', async () => {
    const result=await mod.callAutoDev(baseOptions);
    expect(result).toMatchObject({status:'unverifiable',reason:'durable_publication_callbacks_required'});
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockOctokit.git.createRef).not.toHaveBeenCalled();
    expect(mockOctokit.pulls.create).not.toHaveBeenCalled();
  });

  it('should call onProgress at each step', async () => {
    mockBothPasses();
    mockGitHubAPIs();

    const onProgress = vi.fn();
    await callAutoDev({ ...baseOptions, onProgress });

    const msgs = onProgress.mock.calls.map((c) => c[0]);
    expect(msgs).toContain('Starting feedback analysis…');
    expect(msgs).toContain('Reading the repository file tree…');
    expect(msgs.some((m: string) => m.includes('Files to fix'))).toBe(true);
    expect(mockOctokit.pulls.create).not.toHaveBeenCalled();
  });

  it('트리에 없는 modified 경로는 PR 생성 전에 실패한다', async () => {
    // 선정 단계는 통과시키고, 수정안에서만 없는 경로를 지어낸 상황
    mockBothPasses(
      selectionJson,
      JSON.stringify({
        analysis: '환각',
        files: [{
          path: 'src/services/reservationMailService.ts',
          action: 'modified',
          content: '// 지어낸 파일',
        }],
        commit_message: 'fix: x',
        pr_title: 'fix: x',
        pr_body: 'x',
      }),
    );
    mockGitHubAPIs();

    await expect(callAutoDev(baseOptions)).rejects.toThrow(
      /path that is not in the repository/,
    );

    // 검증이 브랜치 생성보다 앞이므로 쓰레기 브랜치도 PR 도 남지 않는다
    expect(mockOctokit.git.createRef).not.toHaveBeenCalled();
    expect(mockOctokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
    expect(mockOctokit.pulls.create).not.toHaveBeenCalled();
  });

  it('선정 단계가 트리에 없는 경로만 내놓으면 중단한다', async () => {
    mockStreamResponse(JSON.stringify({
      reason: '환각',
      candidates: ['src/components/ReservationForm.tsx'],
    }));
    mockGitHubAPIs();

    await expect(callAutoDev(baseOptions)).rejects.toThrow(
      /did not name any file that exists in the repository/,
    );
    expect(mockOctokit.git.createRef).not.toHaveBeenCalled();
  });

  it('이미 존재하는 파일을 created 로 표시해도 기존 파일 수정으로 처리한다', async () => {
    mockBothPasses(
      selectionJson,
      JSON.stringify({
        analysis: 'x',
        files: [{ path: 'src/lib/progress.ts', action: 'created', content: 'new' }],
        commit_message: 'fix: x',
        pr_title: 'fix: x',
        pr_body: 'x',
      }),
    );
    mockGitHubAPIs();

    const prepared=await callAutoDev(baseOptions);
    expect(mod.validatePatches(prepared.fix.files,prepared.ctx.blobShas)).toEqual([
      expect.objectContaining({path:'src/lib/progress.ts',action:'modified',sha:'sha-progress'}),
    ]);
  });

  it('2-pass 프롬프트에 실제 파일 원본이 들어간다', async () => {
    mockBothPasses();
    mockGitHubAPIs();

    await callAutoDev(baseOptions);

    // 1st = 선정 pass, 2nd = 수정안 pass
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const patchPrompt = JSON.parse(mockFetch.mock.calls[1][1].body).messages[0].content;
    expect(patchPrompt).toContain(ORIGINAL_SOURCE);
    expect(patchPrompt).toContain('src/lib/progress.ts');
  });

  it('선정 프롬프트에 레포 파일 목록이 들어가고 예시 경로가 실제 경로다', async () => {
    mockBothPasses();
    mockGitHubAPIs();

    await callAutoDev(baseOptions);

    const selectionPrompt = JSON.parse(mockFetch.mock.calls[0][1].body).messages[0].content;
    expect(selectionPrompt).toContain('src/lib/progress.ts');
    // 예전 프롬프트가 모델을 유도하던 가짜 예시가 남아있으면 안 된다
    expect(selectionPrompt).not.toContain('src/example.ts');
  });

  // ── B5 GitHub 연결 BYO ──────────────────────────────

  it('botId 가 없으면 공용 GITHUB_TOKEN 으로 간다 (기존 봇 동작 불변)', async () => {
    octokitAuths.length = 0;
    mockBothPasses();
    mockGitHubAPIs();
    await callAutoDev(baseOptions);
    expect(octokitAuths).toEqual(['ghp_test']);
  });

  it('봇에 토큰이 있으면 그걸로 Octokit 을 만들고, 진행 메시지가 어느 계정인지 말한다', async () => {
    process.env.BOT_TOKEN_ENCRYPTION_KEY = 'c'.repeat(64);
    vi.resetModules();
    const { encrypt } = await import('@/lib/utils/crypto');
    const fresh = await import('@/lib/auto-dev/ai-engine');
    const BOT_TOKEN = 'github_pat_BOT0000000000000000_00000000000000000000000000000000000000000000000000000000000000';
    botTokenRow.current = encrypt(BOT_TOKEN);
    octokitAuths.length = 0;
    try {
      mockBothPasses();
      mockGitHubAPIs();
      const onProgress = vi.fn();
      await fresh.prepareCodeFix({ ...baseOptions, botId: 'bot-1', onProgress });
      expect(octokitAuths).toEqual([BOT_TOKEN]);
      expect(onProgress.mock.calls.map((c) => c[0])).toContain("Connected with the bot's GitHub token");
    } finally {
      botTokenRow.current = null;
    }
  });

  it('봇 토큰 경로에서 GitHub 이 403 을 주면 실패를 봇 행에 적는다 (화면의 「토큰 확인 필요」)', async () => {
    process.env.BOT_TOKEN_ENCRYPTION_KEY = 'c'.repeat(64);
    vi.resetModules();
    const { encrypt } = await import('@/lib/utils/crypto');
    const fresh = await import('@/lib/auto-dev/ai-engine');
    botTokenRow.current = encrypt('github_pat_BOT0000000000000000_00000000000000000000000000000000000000000000000000000000000000');
    failureRecords.length = 0;
    try {
      mockOctokit.repos.get.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }));
      await expect(fresh.prepareCodeFix({ ...baseOptions, botId: 'bot-1' })).rejects.toThrow('Forbidden');
      expect(failureRecords).toHaveLength(1);
      expect(failureRecords[0]).toMatchObject({ github_token_failed_reason: 'token_rejected' });
    } finally {
      botTokenRow.current = null;
    }
  });

  it('공용 토큰 경로의 403 은 봇 행에 적지 않는다 — 운영자가 고칠 수 있는 게 아니다', async () => {
    failureRecords.length = 0;
    mockOctokit.repos.get.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }));
    await expect(callAutoDev({ ...baseOptions, botId: 'bot-1' })).rejects.toThrow('Forbidden');
    expect(failureRecords).toHaveLength(0);
  });
});

// ─── 임포트 1-hop 그라운딩 (PR #6 재현) ──────────────────────────────────────
//
// 데모 레포 PR #6: 후보 `app/app/coupons/page.tsx` 만 보고 고쳤는데, 그 파일이 import 하는
// `app/lib/coupon-session.ts` 가 이미 같은 실패를 막고 있어 추가한 분기가 죽은 코드였다.
// 이제 후보의 import 이웃이 참고용 원본으로 2-pass 에 들어가야 한다.
describe('callAutoDev — import 이웃 그라운딩', () => {
  let callAutoDev: typeof import('@/lib/auto-dev/ai-engine').prepareCodeFix;
  let prepareCodeFix: typeof import('@/lib/auto-dev/ai-engine').prepareCodeFix;

  const DEMO_TREE = [
    { path: 'app/package.json', type: 'blob', sha: 'sha-pkg', size: 500 },
    { path: 'app/tsconfig.json', type: 'blob', sha: 'sha-tsconfig', size: 300 },
    { path: 'app/app/coupons/page.tsx', type: 'blob', sha: 'sha-page', size: 4000 },
    { path: 'app/app/coupons/page.module.css', type: 'blob', sha: 'sha-css', size: 900 },
    { path: 'app/app/api/coupons/mine/route.ts', type: 'blob', sha: 'sha-mine', size: 600 },
    { path: 'app/components/MyCouponCard.tsx', type: 'blob', sha: 'sha-card', size: 800 },
    { path: 'app/components/icons/index.tsx', type: 'blob', sha: 'sha-icons', size: 800 },
    { path: 'app/lib/coupon-session.ts', type: 'blob', sha: 'sha-session', size: 1200 },
    { path: 'app/lib/i18n/client.tsx', type: 'blob', sha: 'sha-i18n', size: 700 },
  ];

  const PAGE_SOURCE = `"use client";
import styles from "./page.module.css";
import MyCouponCard from "@/components/MyCouponCard";
import { Icon } from "@/components/icons";
import { fetchMyIssues } from "@/lib/coupon-session";
import { useT } from "@/lib/i18n/client";
export default function Page() { return null; }
`;
  const SESSION_SOURCE = `export async function fetchMyIssues() {
  const response = await fetch('/api/coupons/mine');
  if (!response.ok) throw new Error('failed');
  const data = await response.json();
  return Array.isArray(data.issues) ? data.issues : [];
}
`;
  const CONTENTS: Record<string, string> = {
    'app/app/coupons/page.tsx': PAGE_SOURCE,
    'app/lib/coupon-session.ts': SESSION_SOURCE,
    'app/components/MyCouponCard.tsx': 'export default function MyCouponCard() { return null; }',
    'app/lib/i18n/client.tsx': 'export function useT() { return (k: string) => k; }',
    'app/components/icons/index.tsx': 'export function Icon() { return null; }',
  };

  const insight = {
    category: 'bug',
    summary: '쿠폰함 지난 내역 탭이 흰 화면',
    message_body: '쿠폰함에서 지난 내역 탭을 누르면 흰 화면만 나와요',
  };
  const options = { repoUrl: 'https://github.com/wineny/nullnul-tour-demo', insight };

  const selection = JSON.stringify({ reason: '쿠폰 페이지', candidates: ['app/app/coupons/page.tsx'] });

  function mockStream(text: string) {
    const chunks = [
      `data: {"type":"content_block_delta","delta":{"text":${JSON.stringify(text)}}}\n\n`,
      'data: [DONE]\n\n',
    ];
    let i = 0;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: {
        getReader: () => ({
          read: async () =>
            i >= chunks.length
              ? { done: true, value: undefined }
              : { done: false, value: new TextEncoder().encode(chunks[i++]) },
        }),
      },
    });
  }

  function mockDemoRepo() {
    mockOctokit.repos.get.mockResolvedValue({ data: { default_branch: 'main' } });
    mockOctokit.git.getRef.mockResolvedValue({ data: { object: { sha: 'base' } } });
    mockOctokit.git.getTree.mockResolvedValue({ data: { tree: DEMO_TREE } });
    mockOctokit.git.createRef.mockResolvedValue({});
    mockOctokit.repos.getContent.mockImplementation(async ({ path }: { path: string }) => {
      const content = CONTENTS[path];
      if (content === undefined) throw new Error(`Not Found: ${path}`);
      return { data: { type: 'file', sha: 'x', content: Buffer.from(content).toString('base64') } };
    });
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});
    mockOctokit.pulls.create.mockResolvedValue({
      data: { html_url: 'https://github.com/wineny/nullnul-tour-demo/pull/7', number: 7 },
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.GITHUB_TOKEN = 'ghp_test';
    vi.resetModules();
    const mod = await import('@/lib/auto-dev/ai-engine');
    callAutoDev = mod.prepareCodeFix;
    prepareCodeFix = mod.prepareCodeFix;
  });

  it('후보가 import 하는 coupon-session 원본이 2-pass 에 참고용으로 들어간다', async () => {
    mockStream(selection);
    mockStream(JSON.stringify({
      analysis: '이미 fetchMyIssues 가 ok 아님을 throw 로 막고 배열을 정규화한다',
      files: [],
      commit_message: 'x', pr_title: 'x', pr_body: 'x',
    }));
    mockDemoRepo();

    // files 가 비면 정직하게 중단한다 — 모델의 판단(analysis)이 메시지에 실린다
    await expect(callAutoDev(options)).rejects.toThrow(/이미 fetchMyIssues/);

    // 이웃 원본을 실제로 읽었고
    const readPaths = mockOctokit.repos.getContent.mock.calls.map((c) => c[0].path);
    expect(readPaths).toContain('app/lib/coupon-session.ts');

    // 2-pass 프롬프트에 참고용 섹션으로 들어갔다 — 수정 대상 섹션이 아니라
    const patchPrompt: string = JSON.parse(mockFetch.mock.calls[1][1].body).messages[0].content;
    expect(patchPrompt).toContain('Reference sources');
    expect(patchPrompt).toContain(SESSION_SOURCE.trim());
    const targetSection = patchPrompt.split('## Reference sources')[0];
    expect(targetSection).toContain('app/app/coupons/page.tsx');
    expect(targetSection).not.toContain('app/lib/coupon-session.ts');
    // 참고용에 「고치지 말라」는 규칙이 붙어 있다
    expect(patchPrompt).toContain('Do not put files from the "Reference sources" section in files');

    // PR 은 안 만들어졌다
    expect(mockOctokit.git.createRef).not.toHaveBeenCalled();
  });

  it('이웃은 상한(3개) 안에서 로직 모듈이 먼저고 CSS·타입 전용은 안 읽는다', async () => {
    mockStream(selection);
    mockStream(JSON.stringify({
      analysis: 'x',
      files: [{ path: 'app/app/coupons/page.tsx', action: 'modified', content: 'fixed' }],
      commit_message: 'fix: x', pr_title: 'fix: x', pr_body: 'x',
    }));
    mockDemoRepo();

    const prepared = await prepareCodeFix(options);
    const neighborPaths = prepared.neighbors.map((n) => n.path);
    expect(neighborPaths.length).toBeLessThanOrEqual(3);
    expect(neighborPaths[0]).toBe('app/lib/coupon-session.ts');
    expect(neighborPaths).not.toContain('app/app/coupons/page.module.css');
    expect(neighborPaths).not.toContain('app/components/icons/index.tsx');
    expect(prepared.timings).toHaveProperty('neighbors');
  });

  it('PR 본문에 「함께 읽은 파일」 이 실린다', async () => {
    mockStream(selection);
    mockStream(JSON.stringify({
      analysis: '탭 전환 시 상태 초기화 누락',
      files: [{ path: 'app/app/coupons/page.tsx', action: 'modified', content: 'fixed' }],
      commit_message: 'fix: x', pr_title: 'fix: x', pr_body: 'x',
    }));
    mockDemoRepo();

    const result = await callAutoDev(options);
    const {composePrBody}=await import('@/lib/auto-dev/ai-engine');
    const body=composePrBody(result.fix,options.insight,result.fix.files,result.evidence,result.neighbors);
    expect(body).toContain('## Files read for context');
    expect(body).toContain('`app/lib/coupon-session.ts`');
  });

  it('모델이 참고용 파일을 고치겠다고 하면 그 파일을 수정 대상으로 올려 한 번만 더 돌고, 또 참고용이면 멈춘다 (I-24)', async () => {
    // 2026-09-16 이전엔 첫 지목에서 바로 멈췄다. 원인 파일이 1-hop 이웃으로 이미 읽혀 있는 게 가장 흔한 형태라
    // 승격 후 재시도(상한 1회)로 바꿨다 — 두 번째도 참고용을 지목하면 종전 메시지로 멈춘다.
    mockStream(selection);
    mockStream(JSON.stringify({
      analysis: 'x',
      files: [{ path: 'app/lib/coupon-session.ts', action: 'modified', content: 'changed' }],
      commit_message: 'fix: x', pr_title: 'fix: x', pr_body: 'x',
    }));
    mockStream(JSON.stringify({
      analysis: 'x',
      files: [{ path: 'app/components/MyCouponCard.tsx', action: 'modified', content: 'changed' }],
      commit_message: 'fix: x', pr_title: 'fix: x', pr_body: 'x',
    }));
    mockDemoRepo();

    await expect(callAutoDev(options)).rejects.toThrow(/context-only file as the file to change/);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // 재시도 프롬프트에서 coupon-session 은 «수정 대상» 섹션으로 올라갔다
    const retryPrompt: string = JSON.parse(mockFetch.mock.calls[2][1].body).messages[0].content;
    expect(retryPrompt.split('## Reference sources')[0]).toContain('app/lib/coupon-session.ts');
    expect(mockOctokit.git.createRef).not.toHaveBeenCalled();
  });

  it('맥락 대조 결과(evidence)가 2-pass 프롬프트에도 들어간다 — 전에는 선정 pass 에만 갔다', async () => {
    mockStream(selection);
    mockStream(JSON.stringify({
      analysis: 'x',
      files: [{ path: 'app/app/coupons/page.tsx', action: 'modified', content: 'fixed' }],
      commit_message: 'fix: x', pr_title: 'fix: x', pr_body: 'x',
    }));
    mockDemoRepo();

    await callAutoDev({
      ...options,
      insight: {
        ...insight,
        context: '- 실패 요청: 500 /api/coupons/history',
        contextItems: { urls: [], errors: [], requests: ['500 /api/coupons/history'] },
      },
    });

    const patchPrompt: string = JSON.parse(mockFetch.mock.calls[1][1].body).messages[0].content;
    expect(patchPrompt).toContain('⚠️ not found in the repo');
  });

  it('빈 본문으로 오는 이웃(1MB 초과)은 「실제 원본」으로 싣지 않는다', async () => {
    mockStream(selection);
    mockStream(JSON.stringify({
      analysis: 'x',
      files: [{ path: 'app/app/coupons/page.tsx', action: 'modified', content: 'fixed' }],
      commit_message: 'fix: x', pr_title: 'fix: x', pr_body: 'x',
    }));
    mockDemoRepo();
    CONTENTS['app/lib/coupon-session.ts'] = '';
    try {
      const prepared = await prepareCodeFix(options);
      expect(prepared.neighbors.map((n) => n.path)).not.toContain('app/lib/coupon-session.ts');
    } finally {
      CONTENTS['app/lib/coupon-session.ts'] = SESSION_SOURCE;
    }
  });

  it('이웃 하나를 못 읽어도 실행은 이어진다', async () => {
    mockStream(selection);
    mockStream(JSON.stringify({
      analysis: 'x',
      files: [{ path: 'app/app/coupons/page.tsx', action: 'modified', content: 'fixed' }],
      commit_message: 'fix: x', pr_title: 'fix: x', pr_body: 'x',
    }));
    mockDemoRepo();
    delete CONTENTS['app/lib/coupon-session.ts'];
    try {
      const onProgress = vi.fn();
      const prepared = await prepareCodeFix({ ...options, onProgress });
      expect(prepared.neighbors.map((n) => n.path)).not.toContain('app/lib/coupon-session.ts');
      expect(onProgress.mock.calls.some((c) => String(c[0]).includes('Skipped'))).toBe(true);
    } finally {
      CONTENTS['app/lib/coupon-session.ts'] = SESSION_SOURCE;
    }
  });
});

describe('extractPathsFromAnalysis — 분석문에서 실존 경로 뽑기 (I-24)', () => {
  const pool = new Set(['app/app/page.tsx', 'app/lib/board.ts', 'app/lib/data/board.ts', 'app/tsconfig.json', 'app/package.json']);

  it('경로·파일명·한글 붙은 꼴·문장 부호를 다 처리하고 유일하지 않은 파일명은 고르지 않는다', async () => {
    const { extractPathsFromAnalysis } = await import('@/lib/auto-dev/ai-engine');
    expect(extractPathsFromAnalysis('원인은 app/app/page.tsx 의 rankById.', pool)).toEqual(['app/app/page.tsx']);
    expect(extractPathsFromAnalysis('「page.tsx에」 있다(board.ts 는 둘이라 모호).', pool)).toEqual(['app/app/page.tsx']);
    expect(extractPathsFromAnalysis('원인은 **app/app/page.tsx** 다', pool)).toEqual(['app/app/page.tsx']);
    expect(extractPathsFromAnalysis('tsconfig.json 의 paths, package.json, v1.2.json 은 무시', pool)).toEqual([]);
    expect(extractPathsFromAnalysis(undefined, pool)).toEqual([]);
  });

  it('점이 많은 긴 문자열에서도 선형이다 (예전 정규식은 80K자 5초)', async () => {
    const { extractPathsFromAnalysis } = await import('@/lib/auto-dev/ai-engine');
    const t = Date.now();
    expect(extractPathsFromAnalysis('a.'.repeat(100_000), pool)).toEqual([]);
    expect(extractPathsFromAnalysis(('a.'.repeat(140) + ' ').repeat(700), pool)).toEqual([]);
    expect(Date.now() - t).toBeLessThan(300);
  });
});

describe('prepareCodeFix — 3-pass(requested_context) · I-24', () => {
  // 2026-09-12 QA 재현: 1-pass 가 키워드로 딴 파일(hub.ts)을 고르고, 2-pass 는 「고칠 지점은 board.ts 에 있다」고
  // 정확히 알면서도 files 를 비웠다(run 945acc7f). 지목한 파일이 트리에 실존하면 한 번 더 열어 준다(상한 1회·2파일).
  let prepareCodeFix: typeof import('@/lib/auto-dev/ai-engine').prepareCodeFix;

  const TREE = [
    { path: 'app/package.json', type: 'blob', sha: 'sha-pkg', size: 500 },
    { path: 'app/tsconfig.json', type: 'blob', sha: 'sha-tsconfig', size: 300 },
    { path: 'app/app/page.tsx', type: 'blob', sha: 'sha-page', size: 4000 },
    { path: 'app/lib/data/hub.ts', type: 'blob', sha: 'sha-hub', size: 900 },
    { path: 'app/lib/board.ts', type: 'blob', sha: 'sha-board', size: 700 },
    { path: 'app/lib/util.ts', type: 'blob', sha: 'sha-util', size: 300 },
    { path: 'app/lib/extra3.ts', type: 'blob', sha: 'sha-extra3', size: 300 },
    { path: 'app/lib/spots.ts', type: 'blob', sha: 'sha-spots', size: 500 },
    { path: 'app/lib/i18n/client.tsx', type: 'blob', sha: 'sha-i18n', size: 700 },
    { path: 'app/components/Card.tsx', type: 'blob', sha: 'sha-card', size: 800 },
    // 트리엔 있지만 소스 필터(neighborPool) 밖 — 락파일·셸 스크립트
    { path: 'app/package-lock.json', type: 'blob', sha: 'sha-lock', size: 900_000 },
    { path: 'app/run_dev.sh', type: 'blob', sha: 'sha-sh', size: 200 },
  ];

  const HUB_SOURCE = `import { spots } from "@/lib/spots";
import { useT } from "@/lib/i18n/client";
export function popularHubs() { return spots; }
`;
  const SPOTS_SOURCE = 'export const spots = [];';
  const BOARD_SOURCE = `export const rankById = new Map<string, number>();
export function isPick(id: string) { return rankById.get(id) === 1; }
`;
  const UTIL_SOURCE = 'export const noop = () => undefined;';
  const EXTRA3_SOURCE = 'export const three = 3;';
  const I18N_SOURCE = 'export function useT() { return (k: string) => k; }';
  const CONTENTS: Record<string, string> = {
    'app/lib/data/hub.ts': HUB_SOURCE,
    'app/lib/board.ts': BOARD_SOURCE,
    'app/lib/util.ts': UTIL_SOURCE,
    'app/lib/extra3.ts': EXTRA3_SOURCE,
    'app/lib/spots.ts': SPOTS_SOURCE,
    'app/lib/i18n/client.tsx': I18N_SOURCE,
    'app/components/Card.tsx': 'export default function Card() { return null; }',
  };

  const insight = {
    category: 'bug',
    summary: "쿠폰 필터 활성화 시 '오늘의 널널 PICK' 배지가 엉뚱한 가게에 붙음",
    message_body: '쿠폰 필터를 켜면 1위가 아닌 가게에 PICK 배지가 붙어요',
  };
  const options = { repoUrl: 'https://github.com/wineny/nullnul-tour-demo', insight };
  const selection = JSON.stringify({ reason: 'PICK 순위', candidates: ['app/lib/data/hub.ts'] });

  const emptyWithRequest = (requested_context: string[] | undefined, analysis = '세 파일엔 고칠 지점이 없다') =>
    JSON.stringify({ analysis, files: [], commit_message: 'x', pr_title: 'x', pr_body: 'x', ...(requested_context ? { requested_context } : {}) });
  const fixFor = (path: string, content = 'fixed') =>
    JSON.stringify({ analysis: `${path} 의 pick 판정 수정`, files: [{ path, action: 'modified', content }], commit_message: 'fix: pick', pr_title: 'fix: pick', pr_body: 'x' });

  function mockStream(text: string) {
    const chunks = [
      `data: {"type":"content_block_delta","delta":{"text":${JSON.stringify(text)}}}\n\n`,
      'data: [DONE]\n\n',
    ];
    let i = 0;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: {
        getReader: () => ({
          read: async () =>
            i >= chunks.length
              ? { done: true, value: undefined }
              : { done: false, value: new TextEncoder().encode(chunks[i++]) },
        }),
      },
    });
  }

  function mockRepo() {
    mockOctokit.repos.get.mockResolvedValue({ data: { default_branch: 'main' } });
    mockOctokit.git.getRef.mockResolvedValue({ data: { object: { sha: 'base' } } });
    mockOctokit.git.getTree.mockResolvedValue({ data: { tree: TREE } });
    mockOctokit.git.createRef.mockResolvedValue({});
    mockOctokit.repos.getContent.mockImplementation(async ({ path }: { path: string }) => {
      const content = CONTENTS[path];
      if (content === undefined) throw new Error(`Not Found: ${path}`);
      return { data: { type: 'file', sha: 'x', content: Buffer.from(content).toString('base64') } };
    });
  }

  const patchPromptAt = (i: number): string => JSON.parse(mockFetch.mock.calls[i][1].body).messages[0].content;
  const targetSectionAt = (i: number): string => patchPromptAt(i).split('## Reference sources')[0];
  const readPaths = () => mockOctokit.repos.getContent.mock.calls.map((c) => c[0].path as string);

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.GITHUB_TOKEN = 'ghp_test';
    vi.resetModules();
    const mod = await import('@/lib/auto-dev/ai-engine');
    prepareCodeFix = mod.prepareCodeFix;
  });

  it('1차 2-pass 가 files [] + requested_context 를 주면 그 파일을 읽고 2-pass 를 한 번 더 돌아 수정안을 낸다', async () => {
    mockStream(selection);
    mockStream(emptyWithRequest(['app/lib/board.ts'], 'pick 판정은 board.ts 에 있다'));
    mockStream(fixFor('app/lib/board.ts'));
    mockRepo();
    const onProgress = vi.fn();

    const prepared = await prepareCodeFix({ ...options, onProgress });

    // Claude 3회: 선정 → 2-pass → 2-pass(재시도)
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // 지목한 파일을 실제로 읽었고, 재시도 프롬프트의 «수정 대상» 섹션에 원본이 들어갔다
    expect(readPaths()).toContain('app/lib/board.ts');
    expect(targetSectionAt(2)).toContain('app/lib/board.ts');
    expect(targetSectionAt(2)).toContain(BOARD_SOURCE.trim());
    // 1차 프롬프트에는 없었다(그때는 몰랐으니)
    expect(targetSectionAt(1)).not.toContain('app/lib/board.ts');
    expect(prepared.fix.files.map((f) => f.path)).toEqual(['app/lib/board.ts']);
    // 화면(stream)에 왜 두 번 도는지 보인다
    const msgs = onProgress.mock.calls.map((c) => String(c[0]));
    expect(msgs.some((m) => m.includes('extra pass 1/1') && m.includes('app/lib/board.ts'))).toBe(true);
    // 3-pass 여부가 timings 에 따로 남는다
    expect(typeof prepared.timings.patch_retry).toBe('number');
    expect(typeof prepared.timings.patch).toBe('number');
    // 참고용 이웃은 그대로다
    expect(prepared.neighbors.map((n) => n.path)).toContain('app/lib/spots.ts');
  });

  it('2-pass 프롬프트에 requested_context 용 레포 파일 목록이 들어가고, 재시도 프롬프트에는 안 들어간다', async () => {
    mockStream(selection);
    mockStream(emptyWithRequest(['app/lib/board.ts']));
    mockStream(fixFor('app/lib/board.ts'));
    mockRepo();

    await prepareCodeFix(options);

    const first = patchPromptAt(1);
    expect(first).toContain('## Repository file list (for requested_context only)');
    // 1-pass 가 안 고른 정답 파일도 목록에 있어 모델이 경로를 지어내지 않아도 된다
    expect(first.split('## Repository file list')[1]).toContain('app/lib/board.ts');
    expect(first).toContain('"requested_context"');
    expect(patchPromptAt(2)).not.toContain('## Repository file list');
  });

  it('requested_context 가 트리에 없는 경로뿐이면 root_cause_unknown 으로 멈춘다 (2-pass 재시도 없음)', async () => {
    mockStream(selection);
    mockStream(emptyWithRequest(['app/lib/does-not-exist.ts']));
    mockRepo();

    await expect(prepareCodeFix(options)).rejects.toThrow('root_cause_unknown');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(readPaths()).not.toContain('app/lib/does-not-exist.ts');
  });

  it('추가로 읽고 다시 돌려도 files 가 비면 root_cause_unknown — 재시도는 한 번뿐이다', async () => {
    mockStream(selection);
    mockStream(emptyWithRequest(['app/lib/board.ts']));
    mockStream(emptyWithRequest(['app/lib/util.ts'], '이번엔 util.ts 인 것 같다'));
    mockRepo();
    const onProgress = vi.fn();

    await expect(prepareCodeFix({ ...options, onProgress })).rejects.toThrow('root_cause_unknown');
    // 두 번째 판단도 화면에 남는다
    expect(onProgress.mock.calls.some((c) => String(c[0]).includes('이번엔 util.ts 인 것 같다'))).toBe(true);
    // 세 번째 2-pass 는 없다(상한 1회) — util.ts 도 읽지 않는다
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(readPaths()).not.toContain('app/lib/util.ts');
  });

  it('추가 파일은 최대 2개, 이미 읽은 파일은 제외, ./ 와 선행 / 는 정규화한다', async () => {
    mockStream(selection);
    mockStream(emptyWithRequest(['./app/lib/data/hub.ts', '/app/lib/board.ts', 'app/lib/util.ts', 'app/lib/extra3.ts']));
    mockStream(fixFor('app/lib/board.ts'));
    mockRepo();

    await prepareCodeFix(options);

    const reads = readPaths();
    expect(reads.filter((p) => p === 'app/lib/data/hub.ts')).toHaveLength(1); // 다시 읽지 않는다
    expect(reads).toContain('app/lib/board.ts');
    expect(reads).toContain('app/lib/util.ts');
    expect(reads).not.toContain('app/lib/extra3.ts'); // 상한 2개
    expect(targetSectionAt(2)).toContain(BOARD_SOURCE.trim());
    expect(targetSectionAt(2)).toContain(UTIL_SOURCE);
    expect(targetSectionAt(2)).not.toContain(EXTRA3_SOURCE);
  });

  it('requested_context 없이 analysis 에만 실존 경로를 적어도 같은 재시도 경로를 탄다 (run 945acc7f 형)', async () => {
    mockStream(selection);
    mockStream(emptyWithRequest(undefined, '세 파일 중 고칠 지점이 없다 — pick 판정·정렬 순서는 app/lib/board.ts 에 있다'));
    mockStream(fixFor('app/lib/board.ts'));
    mockRepo();

    const prepared = await prepareCodeFix(options);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(readPaths()).toContain('app/lib/board.ts');
    expect(prepared.fix.files.map((f) => f.path)).toEqual(['app/lib/board.ts']);
  });

  it('analysis 의 파일명만으로도 트리에서 유일하게 맞으면 승격한다 (「board.ts 에 있다」)', async () => {
    mockStream(selection);
    mockStream(emptyWithRequest(undefined, '세 파일 중 고칠 지점이 없다 — pick 판정은 주석상 board.ts 에 있다'));
    mockStream(fixFor('app/lib/board.ts'));
    mockRepo();

    const prepared = await prepareCodeFix(options);
    expect(readPaths()).toContain('app/lib/board.ts');
    expect(prepared.fix.files.map((f) => f.path)).toEqual(['app/lib/board.ts']);
  });

  it('Vercel root 기준으로 적은 경로(lib/board.ts)도 트리에서 유일하게 끝이 맞으면 받는다', async () => {
    mockStream(selection);
    mockStream(emptyWithRequest(['lib/board.ts']));
    mockStream(fixFor('app/lib/board.ts'));
    mockRepo();

    const prepared = await prepareCodeFix(options);
    expect(readPaths()).toContain('app/lib/board.ts');
    expect(prepared.fix.files.map((f) => f.path)).toEqual(['app/lib/board.ts']);
  });

  it('지목한 파일을 못 열어 멈출 때 무엇을 지목했는지 진행 메시지에 남긴다', async () => {
    mockStream(selection);
    mockStream(emptyWithRequest(['app/lib/nope.ts'], '원인은 nope.ts 에 있다'));
    mockRepo();
    const onProgress = vi.fn();

    await expect(prepareCodeFix({ ...options, onProgress })).rejects.toThrow('root_cause_unknown');
    const msgs = onProgress.mock.calls.map((c) => String(c[0]));
    expect(msgs.some((m) => m.includes('app/lib/nope.ts') && m.includes('cannot be opened'))).toBe(true);
  });

  it('analysis 에 경로가 없고 requested_context 도 없으면 종전처럼 「수정할 파일이 없습니다」 로 멈춘다', async () => {
    mockStream(selection);
    mockStream(emptyWithRequest(undefined, '이미 방어 코드가 있어 고칠 것이 없다'));
    mockRepo();

    const rejected = expect(prepareCodeFix(options)).rejects;
    await rejected.toThrow(/no file to change/);
    await rejected.toMatchObject({ code: 'no_files' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('requested_context 가 별칭(@/lib/board)뿐이라 하나도 안 풀리면 analysis 의 경로로 폴백한다', async () => {
    mockStream(selection);
    mockStream(emptyWithRequest(['@/lib/board'], 'pick 판정은 app/lib/board.ts 의 rankById 에 있다'));
    mockStream(fixFor('app/lib/board.ts'));
    mockRepo();

    const prepared = await prepareCodeFix(options);
    expect(readPaths()).toContain('app/lib/board.ts');
    expect(prepared.fix.files.map((f) => f.path)).toEqual(['app/lib/board.ts']);
  });

  it('analysis 의 package.json·tsconfig.json·README.md 는 경로로 치지 않는다 (설정 파일 오탐)', async () => {
    mockStream(selection);
    mockStream(emptyWithRequest(undefined, 'tsconfig.json 의 paths 와 package.json 의존성, README.md 를 봐도 고칠 지점이 없다'));
    mockRepo();

    await expect(prepareCodeFix(options)).rejects.toThrow(/no file to change/);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(readPaths()).not.toContain('app/tsconfig.json');
  });

  it('승격한 이웃을 다시 읽지 못하면 run 을 죽이지 않고 손에 쥔 참고용 본문으로 간다', async () => {
    mockStream(selection);
    mockStream(fixFor('app/lib/spots.ts'));
    mockStream(fixFor('app/lib/spots.ts', 'fixed-again'));
    mockRepo();
    let reads = 0;
    const base = mockOctokit.repos.getContent.getMockImplementation()!;
    mockOctokit.repos.getContent.mockImplementation(async (args: { path: string }) => {
      if (args.path === 'app/lib/spots.ts' && ++reads === 2) throw Object.assign(new Error('rate limited'), { status: 403 });
      return base(args);
    });
    const onProgress = vi.fn();

    const prepared = await prepareCodeFix({ ...options, onProgress });
    expect(prepared.fix.files.map((f) => f.path)).toEqual(['app/lib/spots.ts']);
    expect(targetSectionAt(2)).toContain(SPOTS_SOURCE);
    expect(onProgress.mock.calls.some((c) => String(c[0]).includes('continuing with what was already read'))).toBe(true);
  });

  it('시간 가드에 걸려 멈출 때도 AI 가 지목한 파일과 분석문을 남긴다', async () => {
    mockStream(selection);
    mockStream(emptyWithRequest(['app/lib/board.ts'], '원인은 board.ts 의 rankById'));
    mockRepo();
    const { generationBudget } = await import('@/lib/auto-dev/validation-budget');
    const onProgress = vi.fn();

    await expect(
      generationBudget.run(
        { model: 'claude-sonnet-5', calls: 0, inputTokens: 0, outputTokens: 0, reservedUsd: 0, deadline: Date.now() + 30_000 },
        () => prepareCodeFix({ ...options, onProgress }),
      ),
    ).rejects.toThrow('budget_exhausted');
    const msg = onProgress.mock.calls.map((c) => String(c[0])).find((m) => m.includes('left'))!;
    expect(msg).toContain('app/lib/board.ts');
    expect(msg).toContain('rankById');
  });

  it('참고용(이웃) 파일을 고치겠다고 하면 그 이웃을 수정 대상으로 올려 한 번 더 돈다', async () => {
    mockStream(selection);
    mockStream(fixFor('app/lib/spots.ts'));
    mockStream(fixFor('app/lib/spots.ts', 'fixed-again'));
    mockRepo();
    const onProgress = vi.fn();

    const prepared = await prepareCodeFix({ ...options, onProgress });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    // 재시도 프롬프트에서 spots.ts 는 «수정 대상» 이고 참고용이 아니다
    expect(targetSectionAt(2)).toContain('app/lib/spots.ts');
    expect(prepared.fix.files.map((f) => f.path)).toEqual(['app/lib/spots.ts']);
    expect(prepared.neighbors.map((n) => n.path)).not.toContain('app/lib/spots.ts');
    const msgs = onProgress.mock.calls.map((c) => String(c[0]));
    expect(msgs.some((m) => m.includes('extra pass 1/1') && m.includes('app/lib/spots.ts'))).toBe(true);
    expect(typeof prepared.timings.patch_retry).toBe('number');
  });

  it('원본을 읽지 않은 목록 파일을 files 에 넣으면 그 파일을 먼저 읽고 한 번 더 돈다 (읽지 않은 파일을 통째로 덮어쓰지 않는다)', async () => {
    mockStream(selection);
    mockStream(fixFor('app/lib/board.ts', 'made-up-without-reading'));
    mockStream(fixFor('app/lib/board.ts', 'fixed-after-reading'));
    mockRepo();
    const onProgress = vi.fn();

    const prepared = await prepareCodeFix({ ...options, onProgress });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(readPaths()).toContain('app/lib/board.ts');
    expect(targetSectionAt(2)).toContain(BOARD_SOURCE.trim());
    expect(prepared.fix.files[0]).toMatchObject({ path: 'app/lib/board.ts', content: 'fixed-after-reading' });
    expect(onProgress.mock.calls.some((c) => String(c[0]).includes('has not read') && String(c[0]).includes('extra pass 1/1'))).toBe(true);
  });

  it('트리엔 있지만 소스 필터 밖인 파일(package-lock.json·run_dev.sh)을 고치겠다고 하면 재시도 없이 바로 멈춘다', async () => {
    mockStream(selection);
    mockStream(JSON.stringify({
      analysis: 'x',
      files: [
        { path: 'app/package-lock.json', action: 'modified', content: '{}' },
        { path: 'app/run_dev.sh', action: 'created', content: 'rm -rf /' },
      ],
      commit_message: 'x', pr_title: 'x', pr_body: 'x',
    }));
    mockRepo();

    await expect(prepareCodeFix(options)).rejects.toThrow(/file it never read as the file to change.*package-lock\.json.*run_dev\.sh/);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(readPaths()).not.toContain('app/package-lock.json');
    expect(mockOctokit.git.createRef).not.toHaveBeenCalled();
  });

  it('재시도 뒤에도 읽지 않은 파일을 고치겠다고 하면 PR 없이 멈춘다', async () => {
    mockStream(selection);
    mockStream(fixFor('app/lib/board.ts'));
    mockStream(fixFor('app/lib/util.ts'));
    mockRepo();

    await expect(prepareCodeFix(options)).rejects.toThrow(/file it never read as the file to change/);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockOctokit.git.createRef).not.toHaveBeenCalled();
  });

  it('재시도 상한은 합쳐서 1회 — requested_context 로 한 번 돈 뒤 또 이웃을 고치겠다고 하면 멈춘다', async () => {
    mockStream(selection);
    mockStream(emptyWithRequest(['app/lib/board.ts']));
    mockStream(fixFor('app/lib/spots.ts'));
    mockRepo();

    await expect(prepareCodeFix(options)).rejects.toThrow(/context-only file as the file to change/);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockOctokit.git.createRef).not.toHaveBeenCalled();
  });

  it('남은 시간이 2-pass 평균(90초)보다 적으면 재시도하지 않고 budget_exhausted 로 멈춘다', async () => {
    mockStream(selection);
    mockStream(emptyWithRequest(['app/lib/board.ts']));
    mockRepo();
    const { generationBudget } = await import('@/lib/auto-dev/validation-budget');
    const onProgress = vi.fn();

    await expect(
      generationBudget.run(
        { model: 'claude-sonnet-5', calls: 0, inputTokens: 0, outputTokens: 0, reservedUsd: 0, deadline: Date.now() + 30_000 },
        () => prepareCodeFix({ ...options, onProgress }),
      ),
    ).rejects.toThrow('budget_exhausted');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(readPaths()).not.toContain('app/lib/board.ts');
    expect(onProgress.mock.calls.some((c) => String(c[0]).includes('left'))).toBe(true);
  });

  it('남은 시간이 넉넉하면 예산 안에서도 재시도한다', async () => {
    mockStream(selection);
    mockStream(emptyWithRequest(['app/lib/board.ts']));
    mockStream(fixFor('app/lib/board.ts'));
    mockRepo();
    const { generationBudget } = await import('@/lib/auto-dev/validation-budget');

    const prepared = await generationBudget.run(
      { model: 'claude-sonnet-5', calls: 0, inputTokens: 0, outputTokens: 0, reservedUsd: 0, deadline: Date.now() + 200_000 },
      () => prepareCodeFix(options),
    );
    expect(prepared.fix.files.map((f) => f.path)).toEqual(['app/lib/board.ts']);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

describe('callAutoDev — 짚은 요소를 저장소 원본과 대조 (B3 3차)', () => {
  let prepareCodeFix: typeof import('@/lib/auto-dev/ai-engine').prepareCodeFix;
  let composePrBody: typeof import('@/lib/auto-dev/ai-engine').composePrBody;

  const TREE = [
    { path: 'app/package.json', type: 'blob', sha: 'sha-pkg', size: 500 },
    { path: 'app/app/page.tsx', type: 'blob', sha: 'sha-home', size: 4000 },
    { path: 'app/app/coupons/page.tsx', type: 'blob', sha: 'sha-page', size: 4000 },
    { path: 'app/components/RegionSelector.tsx', type: 'blob', sha: 'sha-region', size: 900 },
    { path: 'app/components/RegionSelector.module.css', type: 'blob', sha: 'sha-region-css', size: 300 },
    { path: 'app/components/CouponCard.tsx', type: 'blob', sha: 'sha-card', size: 800 },
    { path: 'app/lib/coupon-session.ts', type: 'blob', sha: 'sha-session', size: 1200 },
  ];
  const REGION_SOURCE = `"use client";
export default function RegionSelector() {
  return <button className={styles.pill} data-testid="region-jongno">서울 종로</button>;
}
`;
  const BLOBS: Record<string, string> = {
    'sha-region': REGION_SOURCE,
    'sha-region-css': '.pill { border-radius: 999px }',
    'sha-home': 'export default function Home() { return null; }',
    'sha-page': 'export default function Coupons() { return null; }',
  };
  const target = {
    kind: '버튼', tag: 'button',
    selector: 'main > section:nth-of-type(1) > div > button:nth-of-type(1)',
    text: '서울 종로', path: 'main > section > div > button',
    html: '<button class="RegionSelector_pill__f0btH" data-testid="region-jongno"></button>',
    url: 'https://nullnul-tour-demo.vercel.app/',
  };
  const insight = {
    category: 'bug',
    summary: '지역 버튼을 눌러도 목록 스크롤이 안 올라감',
    message_body: '서울 종로를 누르면 랭킹이 바뀌는데 스크롤이 위로 안 가요',
    context: '- 제보자가 화면에서 짚은 요소:\n  · 「서울 종로」 버튼',
    contextItems: undefined as unknown as import('@/lib/widget/verify-context').ContextItems,
  };
  const options = { repoUrl: 'https://github.com/wineny/nullnul-tour-demo', insight };

  function mockStream(text: string) {
    const chunks = [
      `data: {"type":"content_block_delta","delta":{"text":${JSON.stringify(text)}}}\n\n`,
      'data: [DONE]\n\n',
    ];
    let i = 0;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: {
        getReader: () => ({
          read: async () =>
            i >= chunks.length
              ? { done: true, value: undefined }
              : { done: false, value: new TextEncoder().encode(chunks[i++]) },
        }),
      },
    });
  }
  const selection = JSON.stringify({ reason: '지역 선택 컴포넌트', candidates: ['app/components/RegionSelector.tsx'] });
  const patch = JSON.stringify({
    analysis: 'x',
    files: [{ path: 'app/components/RegionSelector.tsx', action: 'modified', content: 'fixed' }],
    commit_message: 'fix: x', pr_title: 'fix: x', pr_body: 'x',
  });

  function mockRepo(blobs: Record<string, string> = BLOBS) {
    mockOctokit.repos.get.mockResolvedValue({ data: { default_branch: 'main' } });
    mockOctokit.git.getRef.mockResolvedValue({ data: { object: { sha: 'base' } } });
    mockOctokit.git.getTree.mockResolvedValue({ data: { tree: TREE } });
    mockOctokit.git.getBlob.mockImplementation(async ({ file_sha }: { file_sha: string }) => {
      const content = blobs[file_sha];
      if (content === undefined) throw new Error(`Not Found: ${file_sha}`);
      return { data: { encoding: 'base64', content: Buffer.from(content).toString('base64') } };
    });
    mockOctokit.repos.getContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path !== 'app/components/RegionSelector.tsx') throw new Error(`Not Found: ${path}`);
      return { data: { type: 'file', sha: 'x', content: Buffer.from(REGION_SOURCE).toString('base64') } };
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.GITHUB_TOKEN = 'ghp_test';
    vi.resetModules();
    const ctxMod = await import('@/lib/widget/context');
    insight.contextItems = ctxMod.collectContextItems([{ target }]);
    const mod = await import('@/lib/auto-dev/ai-engine');
    prepareCodeFix = mod.prepareCodeFix;
    composePrBody = mod.composePrBody;
  });

  it('원본에서 식별자를 찾으면 선정 프롬프트에 「이 파일이 그린다」, PR 본문 「보낸 값」에 파일, 체크리스트 경고 없음', async () => {
    mockStream(selection);
    mockStream(patch);
    mockRepo();
    const progress: string[] = [];

    const prepared = await prepareCodeFix({ ...options, onProgress: (m) => progress.push(m) });

    // 트리 조회 뒤·1-pass 전에 blob 을 읽었다 — 후보 순서대로, RegionSelector 가 먼저
    const shas = mockOctokit.git.getBlob.mock.calls.map((c) => c[0].file_sha);
    expect(shas[0]).toBe('sha-region');
    expect(shas.length).toBeLessThanOrEqual(8);
    expect(progress.some((m) => m.startsWith('Checked picked elements against the source: confirmed in 2 files'))).toBe(true);

    const selectionPrompt: string = JSON.parse(mockFetch.mock.calls[0][1].body).messages[0].content;
    expect(selectionPrompt).toContain('confirmed in the repo source, rendered by: app/components/RegionSelector.tsx, app/components/RegionSelector.module.css');
    expect(selectionPrompt).toContain("data-testid 'region-jongno'");
    expect(selectionPrompt).toContain('put **that file first** among the candidates');
    expect(selectionPrompt).not.toContain('확인 못 함, 대조 불가):'); // 규칙 문장에도 같은 말이 있으니 판정 라벨(콜론)로 본다

    const body = composePrBody(prepared.fix, insight, [{ path: 'app/components/RegionSelector.tsx', action: 'modified' }], prepared.evidence);
    expect(body).toContain('- Picked element: "서울 종로" button → `app/components/RegionSelector.tsx`');
    expect(body).not.toContain('was not found in the repository source');
    expect(body).not.toContain('html:');
    expect(prepared.evidence?.hasUnverifiedTargets).toBe(false);
  });

  it('음성 대조 — 원본에 그 문자열이 없으면 확인으로 올리지 않는다(대조가 진짜로 내용을 본다)', async () => {
    mockStream(selection);
    mockStream(patch);
    mockRepo({
      'sha-region': 'export default function RegionSelector() { return null; }',
      'sha-region-css': '.other {}',
      'sha-home': 'x', 'sha-page': 'y',
    });
    const progress: string[] = [];

    const prepared = await prepareCodeFix({ ...options, onProgress: (m) => progress.push(m) });

    expect(mockOctokit.git.getBlob).toHaveBeenCalled(); // 읽긴 읽었다 — 안 읽어서 unknown 인 게 아니다
    expect(progress.some((m) => /read \d+ candidates, found nothing/.test(m))).toBe(true);
    const selectionPrompt: string = JSON.parse(mockFetch.mock.calls[0][1].body).messages[0].content;
    expect(selectionPrompt).not.toContain('rendered by: '); // 규칙 문장엔 같은 말이 있으니 판정 라벨(콜론)로 본다
    expect(selectionPrompt).toContain('not found in the repo source, cannot be matched');
    const body = composePrBody(prepared.fix, insight, [], prepared.evidence);
    expect(body).toContain('was not found in the repository source');
    expect(body).toContain("Picked elements sent by the reporter's browser (unverified input");
    expect(prepared.evidence?.hasUnverifiedTargets).toBe(true);
  });

  it('blob 을 못 읽어도(권한·403) 실행은 이어지고 종전처럼 「대조 불가」', async () => {
    mockStream(selection);
    mockStream(patch);
    mockRepo({});
    const progress: string[] = [];

    const prepared = await prepareCodeFix({ ...options, onProgress: (m) => progress.push(m) });

    // 「후보 없음」이 아니라 「못 읽음」이라고 말해야 한다 — 권한 문제가 휴리스틱 실패로 읽히면 안 된다
    expect(progress.some((m) => /Could not read any of the \d+ candidate files/.test(m))).toBe(true);
    expect(progress.some((m) => m.includes('No candidate files'))).toBe(false);
    expect(prepared.fix.files[0].path).toBe('app/components/RegionSelector.tsx');
    expect(prepared.evidence?.hasUnverifiedTargets).toBe(true);
  });

  it('후보가 많아도 blob 읽기는 8개까지', async () => {
    mockStream(selection);
    mockStream(patch);
    mockRepo();
    const bigTree = [
      ...TREE,
      ...Array.from({ length: 30 }, (_, i) => ({ path: `app/components/RegionSelectorItem${i}.tsx`, type: 'blob', sha: `sha-item-${i}`, size: 100 })),
    ];
    mockOctokit.git.getTree.mockResolvedValue({ data: { tree: bigTree } });

    await prepareCodeFix(options);

    expect(mockOctokit.git.getBlob.mock.calls.length).toBe(8);
  });
});

describe('filterSourceFiles', () => {
  let filterSourceFiles: typeof import('@/lib/auto-dev/ai-engine').filterSourceFiles;

  beforeEach(async () => {
    vi.resetModules();
    ({ filterSourceFiles } = await import('@/lib/auto-dev/ai-engine'));
  });

  it('node_modules·빌드 산출물·lock 파일·바이너리를 걸러낸다', () => {
    const result = filterSourceFiles(REPO_TREE);

    expect(result).toContain('src/lib/progress.ts');
    expect(result).toContain('src/lib/format.ts');
    expect(result).toContain('README.md');

    expect(result).not.toContain('node_modules/left-pad/index.js');
    expect(result).not.toContain('.next/static/chunk.js');
    expect(result).not.toContain('package-lock.json');
    expect(result).not.toContain('public/logo.png');
    expect(result).not.toContain('src'); // tree 엔트리
  });

  it('지나치게 큰 파일은 제외한다 (통째로 다시 받을 수 없다)', () => {
    expect(filterSourceFiles(REPO_TREE)).not.toContain('src/lib/huge.ts');
  });

  it('정렬된 경로를 돌려준다', () => {
    const result = filterSourceFiles(REPO_TREE);
    expect(result).toEqual([...result].sort());
  });
});
