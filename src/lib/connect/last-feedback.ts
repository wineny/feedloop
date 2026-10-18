// 「마지막 피드백」 시각을 한 구절로 — 연결 현황판이 쓰는 표기.
//
// 별도 모듈인 이유: **시각 포맷은 조용히 틀리는 종류**다. 화면은 멀쩡해 보이는데 값만
// 한 시간씩 어긋나거나 「오전/오후」가 「AM/PM」으로 갈린다(실제로 한 번 겪었다).
// 눈으로 확인하기 어려운 만큼 테스트가 값을 한다.

/**
 * 오늘·어제만 상대 표현을 쓰고 그 앞은 날짜로 적는다 — 「3일 전」은 읽는 사람이 날짜를
 * 다시 세어야 한다.
 *
 * 기준 시간대는 KST 로 굳힌다. 서버(Vercel)는 UTC 로 도는데 그대로 두면 한국 시간 오전 8시
 * 이전에 들어온 피드백이 「어제」로 보인다.
 *
 * @param now 비교 기준. 테스트가 「오늘」을 고정하려고 넘긴다
 */
export function lastFeedbackLabel(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '아직 들어온 피드백이 없어요';

  const at = new Date(iso);
  // 대화는 있는데 시각을 못 읽은 것이라, 「피드백이 없다」고 하면 거짓말이 된다.
  // timestamptz 라 실제로는 안 생기지만 생기면 사실대로 말한다.
  if (Number.isNaN(at.getTime())) return '마지막 피드백 시각을 읽지 못했어요';

  const day = kstDayNumber(at);
  const today = kstDayNumber(now);

  if (day === today) return `오늘 ${kstTime(at)}에 마지막 피드백`;
  if (day === today - 1) return `어제 ${kstTime(at)}에 마지막 피드백`;
  return `${kstDate(at)}에 마지막 피드백`;
}

/** KST 자정 기준 일련번호. 「오늘/어제」 판정만 하므로 날짜 경계만 맞으면 된다. */
export function kstDayNumber(d: Date): number {
  return Math.floor((d.getTime() + 9 * 60 * 60 * 1000) / 86_400_000);
}

// ko-KR 로 바로 포맷하면 런타임 ICU 에 따라 「오후 4:18」과 「PM 4:18」로 갈린다(실측 —
// 이 레포의 formatKst 가 같은 이유로 부품 조립을 쓴다). 부품만 받아 우리가 조립한다.
const KST_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Seoul',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function kstPartsOf(d: Date): Record<string, string> {
  return Object.fromEntries(KST_PARTS.formatToParts(d).map((x) => [x.type, x.value]));
}

/** 「오후 4:18」 */
export function kstTime(d: Date): string {
  const p = kstPartsOf(d);
  const hour24 = Number(p.hour);
  const period = hour24 < 12 ? '오전' : '오후';
  // 0시는 「오전 12시」, 12시는 「오후 12시」 — 12 로 나눈 나머지가 0 인 두 경우가 같은 자리다
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${period} ${hour12}:${p.minute}`;
}

/** 「9월 12일」 */
export function kstDate(d: Date): string {
  const p = kstPartsOf(d);
  return `${Number(p.month)}월 ${Number(p.day)}일`;
}
