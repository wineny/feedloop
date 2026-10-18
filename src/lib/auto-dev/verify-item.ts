// [AI 에게 확인시키기] — 「확인하지 못한 것」 중 코드로 확인되는 항목 하나를 다시 판단한다 (I-19).
//
// 엔진이 「관련 파일을 못 봤다」고 할 때는 그 파일 경로를 안다. PR #8 은 `identity.ts` 였고,
// 1-hop 순위에서 i18n 파일에 밀려 못 읽은 것이다(I-17). 여기서는 **그 파일만** 읽고
// **그 항목만** 다시 묻는다 — PR 을 새로 만들지 않고, 결과를 같은 자리에 쓰고 PR 댓글로도 남긴다.
// 호출 1번, 파일 3개 × 40KB 상한. 자유 입력은 받지 않는다.
//
// 「이 수정은 증상을 못 고친다」로 나오면 화면이 「인과가 틀린 수정」 사유가 미리 채워진
// [반영하지 않기] 를 붙인다. PR #6·#8 계열이 여기서 걸러진다.

import { VERDICT_LABEL } from './review-labels';
import { callClaude } from '@/lib/auto-dev/ai-engine';
import { fetchFileAtRef, type PrFile } from '@/lib/auto-dev/pr-review';
import {
  isVerdictStatus,
  VERDICT_TEXT_MAX,
  type RunExplanation,
  type UnverifiedItem,
  type UnverifiedVerdict,
} from '@/lib/auto-dev/explanation';

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
  if (blocks.length === 0 && omitted.length === 0) return '(diff 없음)';
  if (omitted.length > 0) {
    blocks.push(
      `(분량 때문에 diff 를 싣지 않은 파일 ${omitted.length}개: ${omitted.slice(0, 10).map((p) => `\`${p}\``).join(', ')}${omitted.length > 10 ? ' …' : ''}. ` +
        '이 파일들의 변경은 여기 보이지 않으므로 「diff 에 없다」를 근거로 판정하지 마세요.)',
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

  return `당신은 코드 리뷰어입니다. 아래 수정안(PR)을 만들 때 AI 가 **확인하지 못했다고 스스로 적은 항목** 하나를,
그때 못 읽었던 파일의 실제 원본을 보고 다시 판단하세요.

## 수정안
- 제목: ${input.title}
- 무엇이 문제였나: ${input.explanation.problem}
- 무엇을 바꿨나: ${input.explanation.change}

## 확인하지 못했던 것
"${input.item.text}"

## 수정안의 diff
${diff}

## 그때 못 읽었던 파일의 실제 원본
${src}

## 응답 형식
반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트 없이 JSON만 출력하세요.

\`\`\`json
{
  "status": "fix_holds | fix_does_not_hold | inconclusive",
  "text": "판정 이유 2~3문장. 코드를 모르는 서비스 담당자가 읽습니다 — 파일명·함수명 없이, 무엇이 어떻게 확인됐는지"
}
\`\`\`

## 규칙
- **fix_holds**: 원본을 보니 수정안이 겨냥한 실패 경로가 실제로 존재하고, 이 수정이 그 경로를 막는다.
- **fix_does_not_hold**: 원본을 보니 그 실패 경로가 없거나(이미 다른 곳에서 막고 있음, 도달 불가능),
  수정이 증상과 무관하다. 이 경우 text 에 「이 수정은 증상을 고치지 못한다」는 뜻과 그 이유를 쓰세요.
- **inconclusive**: 이 파일만으로는 판단할 수 없다. 무엇이 더 필요한지 쓰세요.
- 원본에 없는 것을 지어내지 마세요. 확실하지 않으면 inconclusive 입니다.
- text 는 담당자 말로 쓰세요. "resolveCouponUserId 가 try/catch 로 감싸져" 가 아니라
  "그 단계는 안에서 이미 오류를 잡아 빈 값을 돌려주므로, 옮긴 자리에서 오류가 날 경로가 없어요" 처럼.`;
}

function parseVerdict(text: string): { status: UnverifiedVerdict['status']; text: string } {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('확인 결과를 읽지 못했어요 (JSON 없음)');
  const parsed = JSON.parse(m[0]) as { status?: unknown; text?: unknown };
  if (!isVerdictStatus(parsed.status)) throw new Error('확인 결과의 판정값이 형식에 맞지 않아요');
  const body = typeof parsed.text === 'string' ? parsed.text.replace(/\s+/g, ' ').trim() : '';
  if (!body) throw new Error('확인 결과에 설명이 없어요');
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
      content: content.length > VERIFY_FILE_BYTES ? `${content.slice(0, VERIFY_FILE_BYTES)}\n… (이하 생략)` : content,
    });
  }

  const checkedAt = new Date().toISOString();
  if (sources.length === 0) {
    return {
      status: 'inconclusive',
      text: '확인하려던 파일을 저장소에서 읽지 못했어요. 파일이 옮겨졌거나 지워졌을 수 있어요 — 프리뷰에서 직접 확인해 주세요.',
      checkedAt,
      files: [],
    };
  }

  const raw = await callClaude(buildVerifyPrompt(input, sources), 1024, '확인 중');
  const verdict = parseVerdict(raw);
  return { ...verdict, checkedAt, files: sources.map((s) => s.path) };
}

export { VERDICT_LABEL } from './review-labels';

/** PR 댓글 본문 — GitHub 쪽에서 보는 사람도 같은 결론을 본다 */
export function buildVerdictComment(item: UnverifiedItem, verdict: UnverifiedVerdict): string {
  return [
    `## 🔍 Feedloop AI 코드 검토 의견 — ${VERDICT_LABEL[verdict.status]}`,
    "실제 실행 검증 결과가 아닙니다. 빌드·재현·회귀 검사 기록을 별도로 확인하세요.",
    '',
    `**확인하지 못했던 것**: ${item.text}`,
    '',
    `**읽은 파일**: ${verdict.files.map((f) => `\`${f}\``).join(', ') || '(없음)'}`,
    '',
    verdict.text,
    '',
    '---',
    '🤖 담당자가 Feedloop 「수정안」 화면에서 [AI 에게 확인시키기] 를 눌러 생성했습니다.',
  ].join('\n');
}
