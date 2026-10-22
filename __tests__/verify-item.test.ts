import { describe, it, expect, vi, beforeEach } from 'vitest';

// [AI 에게 확인시키기] — 못 읽었던 파일만 읽고 그 항목만 다시 판단한다. 파일이 없으면 호출 없이 inconclusive.

const { callClaude, fetchFileAtRef } = vi.hoisted(() => ({ callClaude: vi.fn(), fetchFileAtRef: vi.fn() }));
vi.mock('@/lib/auto-dev/ai-engine', () => ({ callClaude, parseRepoInfo: () => ({ owner: 'o', repo: 'r' }) }));
vi.mock('@/lib/auto-dev/pr-review', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auto-dev/pr-review')>();
  return { ...actual, fetchFileAtRef };
});

import { verifyUnverifiedItem, buildVerifyPrompt, buildVerdictComment, VERIFY_FILE_BYTES } from '@/lib/auto-dev/verify-item';
import type { RunExplanation, UnverifiedItem } from '@/lib/auto-dev/explanation';

const explanation: RunExplanation = { problem: '흰 화면', change: '오류 처리 안으로', effect: '안내 문구', unverified: [], source: 'model' };
const item: UnverifiedItem = { text: '파일을 못 봤다', verifiableBy: 'code', files: ['app/lib/identity.ts'], question: null, verdict: null };
const input = {
  repoUrl: 'https://github.com/o/r', headSha: 'sha', title: '쿠폰함', explanation, item,
  files: [{ path: 'a.ts', patch: '@@ -1 +1 @@\n-a\n+b' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchFileAtRef.mockResolvedValue('export function resolve() { try { … } catch { return null } }');
  callClaude.mockResolvedValue('```json\n{"status":"fix_does_not_hold","text":"그 단계는 안에서 이미 오류를 잡아요"}\n```');
});

describe('verifyUnverifiedItem', () => {
  it('botId 가 있으면 파일 읽기가 그 봇 토큰 기준으로 간다 (B5)', async () => {
    await verifyUnverifiedItem({ ...input, botId: 'bot-1' });
    expect(fetchFileAtRef).toHaveBeenCalledWith('https://github.com/o/r', 'app/lib/identity.ts', 'sha', { botId: 'bot-1' });
  });

  it('파일을 PR 헤드 시점에서 읽고, 판정을 돌려준다', async () => {
    const v = await verifyUnverifiedItem(input);
    // B5: 넷째 인자 = 봇 토큰 기준(테스트 입력엔 botId 가 없어 undefined)
    expect(fetchFileAtRef).toHaveBeenCalledWith('https://github.com/o/r', 'app/lib/identity.ts', 'sha', { botId: undefined });
    expect(v).toMatchObject({ status: 'fix_does_not_hold', files: ['app/lib/identity.ts'] });
    expect(v.text).toContain('이미 오류를 잡아요');
    expect(callClaude).toHaveBeenCalledTimes(1);
  });

  it('파일을 하나도 못 읽으면 호출 없이 inconclusive', async () => {
    fetchFileAtRef.mockResolvedValue(null);
    const v = await verifyUnverifiedItem(input);
    expect(v.status).toBe('inconclusive');
    expect(v.files).toEqual([]);
    expect(callClaude).not.toHaveBeenCalled();
  });

  it('큰 파일은 앞부분만 넣는다', async () => {
    fetchFileAtRef.mockResolvedValue('x'.repeat(VERIFY_FILE_BYTES + 100));
    await verifyUnverifiedItem(input);
    const prompt = callClaude.mock.calls[0][0] as string;
    expect(prompt).toContain('rest omitted');
    expect(prompt.length).toBeLessThan(VERIFY_FILE_BYTES + 5000);
  });

  it('모델이 형식을 어기면 throw — 라우트가 502 로 답한다', async () => {
    callClaude.mockResolvedValue('{"status":"maybe","text":"?"}');
    await expect(verifyUnverifiedItem(input)).rejects.toThrow(/verdict status/);
    callClaude.mockResolvedValue('그냥 문장');
    await expect(verifyUnverifiedItem(input)).rejects.toThrow(/JSON/);
  });
});

describe('buildVerifyPrompt', () => {
  it('항목·diff·원본이 다 들어가고 세 판정값을 설명한다', () => {
    const p = buildVerifyPrompt(input, [{ path: 'app/lib/identity.ts', content: 'SRC' }]);
    expect(p).toContain('파일을 못 봤다');
    expect(p).toContain('+b');
    expect(p).toContain('SRC');
    expect(p).toContain('fix_holds');
    expect(p).toContain('fix_does_not_hold');
    expect(p).toContain('inconclusive');
  });
});

describe('buildVerdictComment', () => {
  it('GitHub 쪽에서 보는 사람도 같은 결론을 본다', () => {
    const c = buildVerdictComment(item, { status: 'fix_does_not_hold', text: '경로 없음', checkedAt: 'now', files: ['a.ts'] });
    // GitHub 에 남는 글은 영어 고정 — 화면 라벨(VERDICT_LABEL)이 아니라 영어 머리말
    expect(c).toContain('the fix has a problem');
    expect(c).toContain('This is not the result of actually running the code');
    expect(c).toContain('파일을 못 봤다');
    expect(c).toContain('`a.ts`');
    expect(c).toContain('경로 없음');
  });
});

describe('buildDiffBlock — diff 합계 예산', () => {
  it('파일 200개를 넣어도 예산 안이고, 접은 사실을 모델에게 말한다', async () => {
    const { buildDiffBlock, VERIFY_DIFF_BUDGET } = await import('@/lib/auto-dev/verify-item');
    const files = Array.from({ length: 200 }, (_, i) => ({ path: `src/f${i}.ts`, patch: 'x'.repeat(1000) }));
    const out = buildDiffBlock(files, ['src/f150.ts']);
    expect(out.length).toBeLessThan(VERIFY_DIFF_BUDGET + 2000);
    expect(out).toContain('left out of the diff for size');
    expect(out).toContain('do not base a verdict on "it is not in the diff"');
    // 항목과 겹치는 파일이 먼저 실린다
    expect(out.indexOf('### src/f150.ts')).toBeGreaterThan(-1);
    expect(out.indexOf('### src/f150.ts')).toBeLessThan(out.indexOf('### src/f0.ts'));
  });

  it('예산 안이면 전부 싣고 접은 문장이 없다', async () => {
    const { buildDiffBlock } = await import('@/lib/auto-dev/verify-item');
    const out = buildDiffBlock([{ path: 'a.ts', patch: '+a' }, { path: 'b.ts', patch: null }], []);
    expect(out).toContain('### a.ts');
    expect(out).not.toContain('b.ts');
    expect(out).not.toContain('싣지 않은');
  });
});
