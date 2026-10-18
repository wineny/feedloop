// 봇 ↔ GitHub App 설치를 «묶는» 판정 (서버 전용). 설치 콜백과 「설치 확인」 버튼이 같은 함수를 탄다.
//
// 묶는 조건 셋을 전부 만족해야 한다:
//   ① 세션 유저가 그 봇의 소유자(라우트가 resolveOwnedBots 로 확인)
//   ② 우리 앱이 봇 레포에 설치돼 있다 — 앱 JWT 로 GET /repos/{o}/{r}/installation (installation_id 파라미터는 안 믿는다)
//   ③ 설치한 사람이 그 레포에 push 권한이 있다 — 콜백에서 받은 «유저 토큰»으로 GET /repos/{o}/{r} 의 permissions.push
// ③ 이 없으면: 봇 레포를 남의 레포로 적어 둔 계정이, 그 레포 주인이 앱을 설치하는 순간 같이 묶인다.
//
// 「설치 확인」(콜백 없이 누르는 버튼)은 유저 토큰이 없으므로 **이미 묶인 봇의 상태를 다시 보는 것만** 한다 —
// 새로 묶지 않는다. 새로 묶으려면 설치 버튼(→ GitHub → 콜백)을 거쳐야 한다.

import { getServiceRoleClient } from '@/lib/supabase';
import { parseRepoInfo } from '@/lib/github/repo-url';
import { appOctokit, findInstallationForRepo, userCanPush, type GithubAppConfig, type RepoInstallation } from '@/lib/github/app';
import type { Octokit } from '@octokit/rest';

export type BindOutcome =
  | { kind: 'bound'; installation: RepoInstallation }
  | { kind: 'no_repo' }
  | { kind: 'not_installed' }
  | { kind: 'suspended'; installation: RepoInstallation }
  | { kind: 'no_push'; installation: RepoInstallation }
  | { kind: 'unknown_push'; installation: RepoInstallation };

export interface BindTarget {
  botId: string;
  repoUrl: string | null;
}

/**
 * 설치 콜백에서: 유저 토큰으로 push 권한까지 본 뒤 묶는다. 묶었으면 봇 행에 설치 id·계정·시각을 쓰고 lost_* 를 지운다.
 */
export async function bindInstallation(
  config: GithubAppConfig,
  target: BindTarget,
  userToken: string,
  userLogin: string | null,
  deps: { app?: Octokit; now?: () => string } = {},
): Promise<BindOutcome> {
  if (!target.repoUrl) return { kind: 'no_repo' };
  let parsed: { owner: string; repo: string };
  try {
    parsed = parseRepoInfo(target.repoUrl);
  } catch {
    return { kind: 'no_repo' };
  }
  const installation = await findInstallationForRepo(config, parsed.owner, parsed.repo, deps.app ?? appOctokit(config));
  if (!installation) return { kind: 'not_installed' };
  if (installation.suspended) return { kind: 'suspended', installation };

  const push = await userCanPush(userToken, parsed.owner, parsed.repo);
  if (push === null) return { kind: 'unknown_push', installation };
  if (!push) return { kind: 'no_push', installation };

  const now = (deps.now ?? (() => new Date().toISOString()))();
  const { error } = await getServiceRoleClient()
    .from('bots')
    .update({
      github_installation_id: installation.id,
      github_installation_login: installation.login,
      github_installation_connected_at: now,
      github_installation_repo_selection: installation.repositorySelection,
      github_installation_lost_at: null,
      github_installation_lost_reason: null,
      // 누가 묶었는지(GitHub 로그인). 비밀이 아니고 사고 때 「누구의 인가로 묶였나」에 답한다
      github_installation_by: userLogin,
    })
    .eq('id', target.botId);
  if (error) throw new Error(`bind failed: ${error.message}`);
  return { kind: 'bound', installation };
}

export type RecheckOutcome =
  | { kind: 'ok'; installation: RepoInstallation }
  | { kind: 'no_repo' }
  | { kind: 'not_bound' }
  | { kind: 'missing' }
  | { kind: 'suspended'; installation: RepoInstallation }
  | { kind: 'changed'; installation: RepoInstallation };

/**
 * 「설치 확인」: 이미 묶인 설치가 아직 그 레포에 있는지 앱 JWT 로 다시 본다. 없으면 lost=missing, 정지면 suspended.
 * 다른 설치 id 가 나오면(제거 뒤 재설치) `changed` — 새로 묶지 않는다(유저 토큰이 없다). 화면이 「다시 설치」로 안내한다.
 */
export async function recheckInstallation(
  config: GithubAppConfig,
  bot: { id: string; repoUrl: string | null; installationId: number | null },
  deps: { app?: Octokit; now?: () => string } = {},
): Promise<RecheckOutcome> {
  if (!bot.installationId) return { kind: 'not_bound' };
  if (!bot.repoUrl) return { kind: 'no_repo' };
  let parsed: { owner: string; repo: string };
  try {
    parsed = parseRepoInfo(bot.repoUrl);
  } catch {
    return { kind: 'no_repo' };
  }
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const db = getServiceRoleClient();
  const installation = await findInstallationForRepo(config, parsed.owner, parsed.repo, deps.app ?? appOctokit(config));
  if (!installation) {
    await db.from('bots').update({ github_installation_lost_at: now, github_installation_lost_reason: 'missing' }).eq('id', bot.id);
    return { kind: 'missing' };
  }
  if (installation.id !== bot.installationId) {
    await db.from('bots').update({ github_installation_lost_at: now, github_installation_lost_reason: 'missing' }).eq('id', bot.id);
    return { kind: 'changed', installation };
  }
  if (installation.suspended) {
    await db.from('bots').update({ github_installation_lost_at: now, github_installation_lost_reason: 'suspended' }).eq('id', bot.id);
    return { kind: 'suspended', installation };
  }
  await db
    .from('bots')
    .update({
      github_installation_lost_at: null,
      github_installation_lost_reason: null,
      github_installation_login: installation.login,
      github_installation_repo_selection: installation.repositorySelection,
    })
    .eq('id', bot.id);
  return { kind: 'ok', installation };
}
