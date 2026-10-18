// 입구(source) 를 사람이 읽는 말로 바꾸는 한 곳.
//
// 왜 모았나 — 같은 맵이 화면마다 따로 있어서 **입구가 늘 때마다 한 군데씩 빠졌다.**
// 채널톡을 더했을 때 「피드백」 탭은 raw `channel` 을 그대로 찍었고, 「수정 PR」의
// 되돌림 대상은 채널톡 이용자를 「방문자 #」로 불렀다. 둘 다 코드가 틀린 게 아니라
// 고쳐야 할 자리를 못 찾은 것이다. 맵이 하나면 다음 입구는 여기 한 줄로 끝난다.
//
// 라벨은 둘로 나뉜다. **입구 이름**(「채널톡」)과 **그 입구의 사람을 부르는 말**
// (「채널톡 이용자」)은 쓰이는 자리가 달라 한 맵으로 접을 수 없다.

/** 입구 이름. 칩·배지처럼 「어디서 왔나」를 말하는 자리. */
export const SOURCE_LABEL: Record<string, string> = {
  web: '웹 위젯',
  kakao: '카카오톡',
  channel: '채널톡',
};

/**
 * 그 입구의 사람을 부르는 말. 연락처를 안 남긴 사람의 이름 자리에 쓴다.
 *
 * `web` 이 없는 건 빠뜨린 게 아니다 — 폴백이 「방문자」이고 웹 위젯 방문자가
 * 바로 그 기본값이다. 익명화 방침이 `messages.author_name` 에 박는 고정 문자열
 * 「채널톡 이용자」와 채널톡 값이 같아야 한다.
 */
export const PERSON_LABEL: Record<string, string> = {
  kakao: '카카오 사용자',
  channel: '채널톡 이용자',
};

/**
 * 입구 이름. 모르는 입구는 **원문 그대로** 돌려준다.
 *
 * 여기서 '알 수 없음' 같은 말로 덮으면 새 입구가 붙었을 때 화면이 조용히
 * 뭉개진다 — raw 값이 보이는 편이 「라벨을 안 더했다」는 신호가 된다.
 */
export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source;
}

/** 그 입구의 사람 호칭. 모르는 입구는 「방문자」. */
export function personLabel(source: string): string {
  return PERSON_LABEL[source] ?? '방문자';
}
