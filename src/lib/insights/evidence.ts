// 제보 원문을 «밖으로 인용할 때» 거치는 공용 마스킹 — 자동 PR(`auto-dev/execute-run.ts`)과
// 스펙 초안(`groups/spec.ts`) 둘이 같이 쓴다. 한쪽만 가리면 같은 묶음이 경로에 따라 다르게 읽히고,
// 안 가린 쪽으로 이메일·주문번호가 GitHub PR 본문이나 스펙 초안에 그대로 실린다.
//
// 결제 대화의 인사이트(설계 §7)는 「<주문번호> <이메일>」 턴에 붙는다. 그 본문을 가리면 남는 게
// 없고 증상(환불 사유)은 인사이트 요약에만 있다 — 그래서 내용이 안 남으면 요약으로 대신한다.

import { maskSecrets } from '@/lib/widget/context';

const MASK = '***';

/**
 * 글 속의 PayPal 주문번호. 실제 id 는 17자(예: 5O190127TN364715T)라 길이를 17로 못박는다 —
 * 8~32자로 두면 에러 코드·SKU·버전(「ERR500XYZ」「AB12CD34EF」)까지 가려져 버그 제보의 증거가 사라진다.
 * 글자와 숫자가 섞인 것만, 대소문자 무시(find_my_payment 는 소문자로 적어도 대문자로 바꿔 받는다).
 */
const ORDER_ID_IN_TEXT_RE = /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{17}\b/gi;

/** 가린 뒤 이보다 적은 낱말만 남으면 «내용이 없는» 본문으로 본다(예: "order *** email ***"). */
const MIN_EVIDENCE_WORDS = 3;

/** 이메일·토큰(maskSecrets)과 PayPal 주문번호를 가린다. */
export function maskEvidence(text: string): string {
  return maskSecrets(text).replace(ORDER_ID_IN_TEXT_RE, MASK);
}

/**
 * 한 제보의 증거 본문. 가릴 것이 없으면 원문 그대로다(기존 제보의 증거는 안 바뀐다).
 * 가리고 나서 내용이 거의 안 남으면 인사이트 요약으로 대신한다.
 */
export function evidenceText(body: string, summary: string): string {
  const masked = maskEvidence(body);
  if (masked === body) return body;
  const words = masked.split(MASK).join(' ').match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length < MIN_EVIDENCE_WORDS && summary.trim() ? summary : masked;
}
