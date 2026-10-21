// 「마지막 피드백」 시각을 오늘·어제·그 전으로 가른다 — 연결 현황판이 쓴다. 문구는 사전(`connect.lastFeedback.<kind>`)이 쓴다.
//
// 별도 모듈인 이유: **시각 판정은 조용히 틀리는 종류**다. 화면은 멀쩡해 보이는데 날짜 경계만
// 하루씩 어긋난다. 눈으로 확인하기 어려운 만큼 테스트가 값을 한다.

export type LastFeedbackParts =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'today' | 'yesterday' | 'date'; at: Date };

/**
 * 오늘·어제만 상대 표현을 쓰고 그 앞은 날짜로 적는다 — 「3일 전」은 읽는 사람이 날짜를
 * 다시 세어야 한다.
 *
 * 날짜 경계는 **보는 사람의 시간대**(`timeZone`)로 자른다. 서버(Vercel)는 UTC 로 도는데 그대로 두면
 * 한국 오전 8시 이전의 피드백이 「어제」로 보인다.
 *
 * @param now 비교 기준. 테스트가 「오늘」을 고정하려고 넘긴다
 */
export function lastFeedbackParts(iso: string | null, now: Date = new Date(), timeZone = 'UTC'): LastFeedbackParts {
  if (!iso) return { kind: 'none' };
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { kind: 'invalid' };
  const day = dayNumber(at, timeZone);
  const today = dayNumber(now, timeZone);
  if (day === today) return { kind: 'today', at };
  if (day === today - 1) return { kind: 'yesterday', at };
  return { kind: 'date', at };
}

/** `timeZone` 의 자정 기준 일련번호. 「오늘/어제」 판정만 하므로 날짜 경계만 맞으면 된다. */
export function dayNumber(d: Date, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return Math.floor(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 86_400_000);
}
