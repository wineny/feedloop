// GitHub 토큰의 «형식» 1차 필터. 의존성 0 — 운영자 화면(클라이언트)이 보내기 전에 쓴다.
//
// lib/llm/key-format.ts 와 같은 이유로 실호출 검증(token.ts)과 갈라 둔다:
// 실호출은 서버에서만 돌아야 하고 클라이언트 번들에 실릴 이유가 없다.
//
// 길이를 하드코딩하지 않는다. fine-grained 토큰은 `github_pat_` 뒤 82자 안팎이지만 GitHub 이
// 길이를 바꾸면 멀쩡한 토큰이 거부되고, 그 사고는 운영자 쪽에서 원인을 알 수 없다.
// 최종 판정은 token.ts 의 verifyGithubToken 실호출이 한다.

/**
 * 사람 계정에 딸린 토큰만 받는다 — fine-grained(`github_pat_…`) · classic(`ghp_…`) ·
 * OAuth 유저 토큰(`gho_`, `gh auth token` 이 주는 것) · GitHub App 유저 토큰(`ghu_`).
 * 설치(installation) 토큰 `ghs_` 과 리프레시 토큰 `ghr_` 은 사람이 붙여 넣을 물건이 아니라 거른다.
 */
const TOKEN_RE = /^(github_pat_[A-Za-z0-9_]{20,}|gh[pou]_[A-Za-z0-9]{20,})$/;

/** `code` 는 화면용(사전 키 `common.validation.<code>`) — `error` 는 서버 응답용 한국어 */
export type TokenFormatResult = { ok: true } | { ok: false; error: string; code: string };

/** 붙여넣기 사고(앞뒤 공백·줄바꿈)와 명백한 오탈자만 거른다. */
export function checkGithubTokenFormat(token: unknown): TokenFormatResult {
  if (typeof token !== 'string' || token.trim() === '') {
    return { ok: false, error: 'GitHub 토큰을 입력해 주세요', code: 'github.empty' };
  }
  if (token !== token.trim()) {
    return { ok: false, error: '토큰 앞뒤에 공백이나 줄바꿈이 섞여 있어요', code: 'github.whitespace' };
  }
  if (!TOKEN_RE.test(token)) {
    return {
      ok: false,
      error: '토큰 형식이 맞지 않아요. fine-grained 토큰은 github_pat_ 로, classic 토큰은 ghp_ 로 시작해요 (gh auth token 이 주는 gho_ 도 돼요)',
      code: 'github.format',
    };
  }
  return { ok: true };
}

/** 화면에 남길 마지막 4자. 원문은 이 4자 외엔 어디에도 남지 않는다. */
export function githubTokenLast4(token: string): string {
  return token.slice(-4);
}
