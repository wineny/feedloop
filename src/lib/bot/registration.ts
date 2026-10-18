// 봇 등록 입력 검증 — 클라이언트 zod 는 curl 로 우회되므로 서버가 다시 본다.
//
// 두 값은 특별히 위험하다.
// - service_name: 무인증 GET /api/widget/[botId]/config 의 displayName 폴백이라 방문자 화면에 그대로 나간다.
// - github_repo_url: 자동 PR 엔진이 플랫폼 공용 GITHUB_TOKEN 으로 여기에 브랜치·PR 을 만든다.
//   느슨하게 받으면 `https://evil.example/?x=github.com/a/b` 같은 값이 통과한다. 앵커된 형태만 받는다.

export const GITHUB_REPO_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/;

export interface RegistrationValues {
  service_name: string;
  service_description: string | null;
  service_url: string | null;
  github_repo_url: string | null;
  pr_mode: 'approve' | 'auto';
}

export type RegistrationResult =
  | { ok: true; values: RegistrationValues }
  | { ok: false; error: string };

const LIMITS = { service_name: 60, service_description: 500, service_url: 500, github_repo_url: 200 } as const;

function optionalString(raw: unknown, label: string, max: number): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: `${label} 은(는) 문자열이어야 합니다` };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > max) return { ok: false, error: `${label} 은(는) ${max}자까지 입력할 수 있습니다` };
  return { ok: true, value: trimmed };
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function validateRegistrationInput(body: unknown): RegistrationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: '잘못된 요청 형식입니다' };
  }
  const input = body as Record<string, unknown>;

  const name = optionalString(input.service_name, '서비스 이름', LIMITS.service_name);
  if (!name.ok) return name;
  if (!name.value || name.value.length < 2) return { ok: false, error: '서비스 이름은 2글자 이상이어야 합니다' };

  const desc = optionalString(input.service_description, '서비스 설명', LIMITS.service_description);
  if (!desc.ok) return desc;

  const url = optionalString(input.service_url, '서비스 URL', LIMITS.service_url);
  if (!url.ok) return url;
  if (url.value && !isHttpUrl(url.value)) return { ok: false, error: '서비스 URL 형식이 올바르지 않습니다' };

  const repo = optionalString(input.github_repo_url, 'GitHub 저장소 URL', LIMITS.github_repo_url);
  if (!repo.ok) return repo;
  if (repo.value && !GITHUB_REPO_URL_RE.test(repo.value)) {
    return { ok: false, error: 'GitHub 저장소 URL 은 https://github.com/<owner>/<repo> 형태여야 합니다' };
  }

  // approve|auto 외 값(누락 포함)은 안전한 기본값인 승인 모드로 접는다.
  const pr_mode = input.pr_mode === 'auto' ? 'auto' : 'approve';

  return {
    ok: true,
    values: {
      service_name: name.value,
      service_description: desc.value,
      service_url: url.value,
      github_repo_url: repo.value ? repo.value.replace(/\/$/, '') : null,
      pr_mode,
    },
  };
}
