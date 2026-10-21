// [AI 에게 확인시키기] — 「확인하지 못한 것」 중 코드로 확인되는 항목 하나를 다시 판단한다 (I-19).
//
// 엔진이 「관련 파일을 못 봤다」고 할 때는 그 파일 경로를 안다. PR #8 은 `identity.ts` 였고,
// 1-hop 순위에서 i18n 파일에 밀려 못 읽은 것이다(I-17). 여기서는 **그 파일만** 읽고
// **그 항목만** 다시 묻는다 — PR 을 새로 만들지 않고, 결과를 같은 자리에 쓰고 PR 댓글로도 남긴다.
// 호출 1번, 파일 3개 × 40KB 상한. 자유 입력은 받지 않는다.
//
// 「이 수정은 증상을 못 고친다」로 나오면 화면이 「인과가 틀린 수정」 사유가 미리 채워진
// [반영하지 않기] 를 붙인다. PR #6·#8 계열이 여기서 걸러진다.

import { callClaude } from '@/lib/auto-dev/ai-engine';
import { fetchFileAtRef, type PrFile } from '@/lib/auto-dev/pr-review';
import {
  isVerdictStatus,
  VERDICT_TEXT_MAX,
  type RunExplanation,
  type UnverifiedItem,
  type UnverifiedVerdict,
} from '@/lib/auto-dev/explanation';
import { OWNER_CONTENT_LANGUAGE } from '@/i18n/owner-locale';

/** 파일 하나가 이보다 크면 앞부분만 넣는다 — 계약(함수 서명·throw·반환)은 대개 앞에 있다 */
export const VERIFY_FILE_BYTES = 40_000;
/**
 * diff 합계 예산. 파일별 20K 상한만 있으면 파일 100개짜리 PR 이 2MB 를 한 프롬프트에 싣는다.
 * 판단에 쓰이는 건 그 항목이 가리키는 파일 주변이지 PR 전체가 아니다 — 겹치는 파일부터 싣고 나머지는 접는다.
 */
export const VERIFY_DIFF_BUDGET = 60_000;

/** 항목의 파일과 경로 조각이 겹치는 diff 를 앞에 둔다 — 예산이 모자라면 무관한 파일이 먼저 빠지게 */
function rankDiffFiles<T extends { path: string }>(files: T[], itemFiles: string[]): T[] {
  const tokens = new Set(itemFiles.flatMap((f) => f.split('/').map((s) => s.replace(/\.[a-z]+$/i, '').toLowerCase())).filter((t) => t.length >= 3));
  const score = (p: string) => p.split('/').filter((s) => tokens.has(s.replace(/\.[a-z]+$/i, '').toLowerCase())).length;
  return [...files].sort((a, b) => score(b.path) - score(a.path));
}

/** 예산 안에서 diff 블록을 조립한다. 접은 파일이 있으면 그 사실을 문장으로 남긴다(모델이 「diff 에 없다」로 오판하지 않게) */
export function buildDiffBlock(files: Pick<PrFile, 'path' | 'patch'>[], itemFiles: string[], budget = VERIFY_DIFF_BUDGET): string {
  const ranked = rankDiffFiles(files.filter((f) => f.patch), itemFiles);
  const blocks: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const f of ranked) {
    const block = `### ${f.path}\n\`\`\`diff\n${f.patch}\n\`\`\``;
    if (used + block.length > budget) {
      omitted.push(f.path);
      continue;
    }
    blocks.push(block);
    used += block.length;
  }
  if (blocks.length === 0 && omitted.length === 0) return '(no diff)';
  if (omitted.length > 0) {
    blocks.push(
      `(${omitted.length} file(s) left out of the diff for size: ${omitted.slice(0, 10).map((p) => `\`${p}\``).join(', ')}${omitted.length > 10 ? ' …' : ''}. ` +
        'Their changes are not shown here, so do not base a verdict on "it is not in the diff".)',
    );
  }
  return blocks.join('\n\n');
}

export interface VerifyInput {
  repoUrl: string;
  /** 봇 토큰으로 파일을 읽는다 (B5). 없으면 공용 */
  botId?: string | null;
  headSha: string;
  title: string;
  explanation: RunExplanation;
  item: UnverifiedItem;
  /** PR 의 diff — 무엇을 바꿨는지 모델이 보고 판단한다 */
  files: Pick<PrFile, 'path' | 'patch'>[];
}

export function buildVerifyPrompt(
  input: Omit<VerifyInput, 'repoUrl' | 'headSha'>,
  sources: { path: string; content: string }[],
): string {
  const diff = buildDiffBlock(input.files, input.item.files);
  const src = sources.map((s) => `### ${s.path}\n\`\`\`\n${s.content}\n\`\`\``).join('\n\n');

  return `You are a code reviewer. When the AI made the fix (PR) below, it wrote down **one item it said it could not confirm**.
Judge that item again by reading the actual source of the files it could not read then.

## The fix
- Title: ${input.title}
- What was wrong: ${input.explanation.problem}
- What changed: ${input.explanation.change}

## What could not be confirmed
"${input.item.text}"

## The fix's diff
${diff}

## Actual source of the files it could not read
${src}

## Response format
Respond only in the JSON format below. Output only the JSON, with no other text.

\`\`\`json
{
  "status": "fix_holds | fix_does_not_hold | inconclusive",
  "text": "2–3 sentences on the reason for the verdict, for a service owner who does not read code — no file or function names; what was checked and how"
}
\`\`\`

## Rules
- **fix_holds**: the source shows that the failure path the fix targets really exists, and this fix blocks it.
- **fix_does_not_hold**: the source shows that the failure path does not exist (it is already handled elsewhere, or unreachable),
  or the fix has nothing to do with the symptom. In that case, say in text that "this fix does not fix the symptom" and why.
- **inconclusive**: these files are not enough to decide. Say what else is needed.
- Do not invent anything that is not in the source. If you are not sure, it is inconclusive.
- Write text in ${OWNER_CONTENT_LANGUAGE}, in the owner's words. Not "resolveCouponUserId is wrapped in try/catch" but
  "that step already catches the error inside and returns an empty value, so there is no way for an error to happen where the code was moved".`;
}

function parseVerdict(text: string): { status: UnverifiedVerdict['status']; text: string } {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Could not read the verdict (no JSON)');
  const parsed = JSON.parse(m[0]) as { status?: unknown; text?: unknown };
  if (!isVerdictStatus(parsed.status)) throw new Error('The verdict status has the wrong format');
  const body = typeof parsed.text === 'string' ? parsed.text.replace(/\s+/g, ' ').trim() : '';
  if (!body) throw new Error('The verdict has no explanation');
  return { status: parsed.status, text: body.length > VERDICT_TEXT_MAX ? `${body.slice(0, VERDICT_TEXT_MAX - 1)}…` : body };
}

/**
 * 항목 하나를 확인한다. 읽을 파일이 하나도 없으면(지워졌거나 경로가 틀림) 호출 없이 inconclusive.
 * throw 는 LLM 호출 실패·형식 오류뿐이다 — 호출부가 502 로 답한다.
 */
export async function verifyUnverifiedItem(input: VerifyInput): Promise<UnverifiedVerdict> {
  const sources: { path: string; content: string }[] = [];
  for (const path of input.item.files.slice(0, 3)) {
    const content = await fetchFileAtRef(input.repoUrl, path, input.headSha, { botId: input.botId });
    if (content === null || content.trim() === '') continue;
    sources.push({
      path,
      content: content.length > VERIFY_FILE_BYTES ? `${content.slice(0, VERIFY_FILE_BYTES)}\n… (rest omitted)` : content,
    });
  }

  const checkedAt = new Date().toISOString();
  if (sources.length === 0) {
    return {
      status: 'inconclusive',
      text: 'Could not read the files to check from the repository. They may have been moved or deleted — please check in the preview.',
      checkedAt,
      files: [],
    };
  }

  const raw = await callClaude(buildVerifyPrompt(input, sources), 1024, 'Checking');
  const verdict = parseVerdict(raw);
  return { ...verdict, checkedAt, files: sources.map((s) => s.path) };
}

/** GitHub 댓글의 판정 머리말 — GitHub 에 남는 글은 영어 고정(4단계). 화면 라벨은 사전 `monitor.verdict.<status>`. */
const VERDICT_LABEL_EN: Record<UnverifiedVerdict['status'], string> = {
  fix_holds: 'the fix looks well-founded',
  fix_does_not_hold: 'the fix has a problem',
  inconclusive: 'cannot decide',
};

/** PR 댓글 본문 — GitHub 쪽에서 보는 사람도 같은 결론을 본다 */
export function buildVerdictComment(item: UnverifiedItem, verdict: UnverifiedVerdict): string {
  return [
    `## 🔍 Feedloop AI code review opinion — ${VERDICT_LABEL_EN[verdict.status]}`,
    'This is not the result of actually running the code. Check the build, reproduction and regression records separately.',
    '',
    `**What could not be confirmed**: ${item.text}`,
    '',
    `**Files read**: ${verdict.files.map((f) => `\`${f}\``).join(', ') || '(none)'}`,
    '',
    verdict.text,
    '',
    '---',
    '🤖 Generated when the owner pressed [Ask AI to check] on the Feedloop Fix PRs screen.',
  ].join('\n');
}
