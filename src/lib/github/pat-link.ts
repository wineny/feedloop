// fine-grained PAT 발급 화면을 «미리 채워» 여는 링크. 의존성은 repo-url(정규식 하나)뿐이라 클라이언트에서 쓴다.
//
// 왜: 토큰 발급 화면은 이름·설명·대상 계정·만료·권한 다섯 칸을 손으로 채워야 하고, 그중 하나라도
// 틀리면 저장 단계에서 거절되거나(레포 접근 없음) 「수정 PR」 화면의 프리뷰·빌드 칸이 「모름」으로 뜬다.
// GitHub 은 이 폼의 값을 쿼리 파라미터로 받는다 — 운영자가 확인하고 「Generate」 만 누르면 된다.
//
// 파라미터 이름은 GitHub 의 fine-grained 토큰 폼 그대로다(name·description·target_name·expires_in +
// 권한 슬러그). 모르는 파라미터는 GitHub 이 무시하므로, 폼이 바뀌어도 링크는 «빈 폼»으로 열릴 뿐 깨지지 않는다.

import { parseRepoInfo } from '@/lib/github/repo-url';

/** 아무것도 안 채운 맨 폼. 예전 이름이라 남겨 둔다 — 새 코드는 githubPatPrefillUrl 을 쓴다 */
export const GITHUB_PAT_URL = 'https://github.com/settings/personal-access-tokens/new';

/** GitHub 의 토큰 이름 칸 상한 */
const NAME_MAX = 40;
/** 설명 칸 상한(1024). 우리 문구는 한참 짧지만, 넘기면 폼이 통째로 빈 채 열려 조용히 실패한다 */
const DESCRIPTION_MAX = 1024;

const DESCRIPTION =
  'Feedloop auto PR — Contents, Pull requests (read/write), Deployments, Commit statuses (read)';

function ownerRepo(repoUrl: string | null | undefined): { owner: string; repo: string } | null {
  if (!repoUrl) return null;
  try {
    return parseRepoInfo(repoUrl);
  } catch {
    return null;
  }
}

/**
 * 발급 화면을 미리 채워 여는 URL.
 *
 * 레포 URL 이 읽히면 그 레포의 소유자를 `target_name` 으로 박아 준다 — 조직 레포일 때 운영자가
 * 개인 계정을 고른 채 만들면 그 토큰은 레포에 닿지 않는다(저장 단계에서 거절되지만, 한 번 더 돌아가야 한다).
 * 레포가 없으면 서비스 이름으로 토큰 이름만 채운다.
 */
export function githubPatPrefillUrl(repoUrl: string | null, serviceName: string): string {
  const repo = ownerRepo(repoUrl);
  const subject = repo ? `${repo.owner}/${repo.repo}` : serviceName.trim();
  const name = `Feedloop${subject ? ` ${subject}` : ''}`.slice(0, NAME_MAX);

  const params = new URLSearchParams();
  params.set('name', name);
  params.set('description', DESCRIPTION.slice(0, DESCRIPTION_MAX));
  // 레포를 못 읽으면 대상 계정을 «추측하지 않는다» — 틀린 계정이 박히면 고르기보다 고치기가 어렵다
  if (repo) params.set('target_name', repo.owner);
  params.set('expires_in', '90');
  // 권한 — 앞 둘은 PR 을 열기 위해 필수, 뒤 둘은 「수정 PR」 화면의 프리뷰·빌드 칸용(없으면 「모름」)
  params.set('contents', 'write');
  params.set('pull_requests', 'write');
  params.set('deployments', 'read');
  params.set('statuses', 'read');
  return `${GITHUB_PAT_URL}?${params.toString()}`;
}
