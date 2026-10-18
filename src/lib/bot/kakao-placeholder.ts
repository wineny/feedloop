// 카카오 봇에는 봇 토큰이라는 게 없다.
//
// 오픈빌더 스킬 서버는 우리가 URL 을 발급하고 채널 소유자가 붙이는 구조라
// 우리 쪽이 보관할 비밀값 자체가 없다. 그런데 bots.bot_token_encrypted 는
// NOT NULL 이다 (init_schema.sql:41 — 텔레그램만 있던 시절 스키마).
//
// 컬럼을 nullable 로 바꾸는 마이그레이션 대신 자리표시자를 넣는다.
// 이유: 프로덕션의 기존 카카오 봇이 이미 이 값으로 들어가 있고(수동 등록),
// 심사 기간(9/21~10/5) 중 프로덕션 스키마 변경은 위험 대비 얻는 게 없다.
//
// 이 값은 iv:authTag:ciphertext 형식이 아니라서 decrypt() 가 빈 문자열을 돌려준다
// (__tests__/crypto.test.ts 가 그 동작을 고정해 두었다). 카카오 경로는 토큰을
// 쓰지 않으므로 문제되지 않는다.
export const KAKAO_TOKEN_PLACEHOLDER = 'kakao-no-token';
