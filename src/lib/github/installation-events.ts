// GitHub App 웹훅 — 설치를 «잃어버렸다»를 봇 행에 적는 순수 처리기 (라우트가 서명을 검증한 뒤 부른다).
//
// 여기서 «묶지는 않는다». installation.created 의 레포 목록으로 봇을 자동으로 묶으면 봇 레포를 남의 레포로
// 적어 둔 계정도 묶인다 — 묶기는 설치 콜백에서 유저 토큰으로 push 권한을 확인한 뒤에만 한다(lib/github/app.ts).
// 웹훅이 하는 일은 반대 방향뿐: 제거·정지·레포 제외를 보면 그 설치를 쓰는 봇에 lost_* 를 찍고, 복구면 지운다.
//
// GitHub 은 모든 App 에 `installation`·`installation_repositories` 를 구독 없이 보낸다.
// 재전송·순서 뒤바뀜에 안전하도록 «상태만» 쓴다(카운터 없음): 같은 이벤트가 두 번 와도 결과가 같다.

import type { InstallationLostReason } from './app';
import { parseRepoInfo } from './repo-url';

/** service_role 클라이언트 중 여기서 쓰는 조각만 — 테스트가 가짜를 끼운다 */
export interface BotsTable {
  from(table: 'bots'): {
    select(cols: string): {
      eq(col: string, v: unknown): Promise<{ data: unknown[] | null; error: { message: string } | null }>;
    };
    update(patch: Record<string, unknown>): {
      eq(col: string, v: unknown): {
        in(col: string, v: unknown[]): Promise<{ error: { message: string } | null }>;
        is(col: string, v: null): Promise<{ error: { message: string } | null }>;
      };
    };
  };
}

export interface InstallationPayload {
  action?: string;
  installation?: { id?: number; account?: { login?: string } | null };
  repositories?: { full_name?: string }[];
  repositories_removed?: { full_name?: string }[];
  repositories_added?: { full_name?: string }[];
}

export interface EventOutcome {
  event: string;
  action: string | null;
  installationId: number | null;
  /** lost_* 를 찍거나 지운 봇 수 */
  affected: number;
  ignored?: string;
}

interface BotRepoRow {
  id: string;
  github_repo_url: string | null;
  github_installation_lost_reason: string | null;
}

function installationIdOf(payload: InstallationPayload): number | null {
  const id = payload.installation?.id;
  return typeof id === 'number' && Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * https://github.com/Owner/Repo → owner/repo (소문자). 못 읽으면 null.
 *
 * **파서를 하나로 둔다** — 예전엔 여기에 사본 정규식이 있었고, 등록 검증(`lib/bot/registration.ts`)이 받아들이는
 * 형태와 조금이라도 어긋나면 그 봇은 `installation_repositories` 웹훅에서 «조용히» 빠진다(에러 없이
 * 잃어버림·복구를 영영 못 받는다). 직접 SQL 로 레포 URL 을 바꾼 적이 있는 레포라 실제로 일어날 수 있다.
 */
export function repoFullNameOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const { owner, repo } = parseRepoInfo(url);
    return `${owner}/${repo}`.toLowerCase();
  } catch {
    return null;
  }
}

function fullNames(list: { full_name?: string }[] | undefined): Set<string> {
  return new Set((list ?? []).map((r) => (typeof r.full_name === 'string' ? r.full_name.toLowerCase() : '')).filter(Boolean));
}

async function botsOnInstallation(db: BotsTable, installationId: number): Promise<BotRepoRow[]> {
  const { data, error } = await db
    .from('bots')
    .select('id, github_repo_url, github_installation_lost_reason')
    .eq('github_installation_id', installationId);
  if (error) throw new Error(`bots lookup failed: ${error.message}`);
  return (data ?? []) as BotRepoRow[];
}

async function markLost(db: BotsTable, installationId: number, botIds: string[], reason: InstallationLostReason, now: string): Promise<number> {
  if (botIds.length === 0) return 0;
  const { error } = await db
    .from('bots')
    .update({ github_installation_lost_at: now, github_installation_lost_reason: reason })
    .eq('github_installation_id', installationId)
    .in('id', botIds);
  if (error) throw new Error(`mark lost failed: ${error.message}`);
  return botIds.length;
}

async function clearLost(db: BotsTable, installationId: number, botIds: string[], now: string): Promise<number> {
  if (botIds.length === 0) return 0;
  const { error } = await db
    .from('bots')
    .update({ github_installation_lost_at: null, github_installation_lost_reason: null, github_installation_connected_at: now })
    .eq('github_installation_id', installationId)
    .in('id', botIds);
  if (error) throw new Error(`clear lost failed: ${error.message}`);
  return botIds.length;
}

/** `installation` 이벤트: deleted·suspend → 잃어버림, unsuspend → 복구. created 는 무시(묶기는 콜백 몫) */
export async function handleInstallationEvent(db: BotsTable, payload: InstallationPayload, now = new Date().toISOString()): Promise<EventOutcome> {
  const action = payload.action ?? null;
  const installationId = installationIdOf(payload);
  const base = { event: 'installation', action, installationId, affected: 0 };
  if (!installationId) return { ...base, ignored: 'no installation id' };

  if (action === 'deleted' || action === 'suspend') {
    const bots = await botsOnInstallation(db, installationId);
    const reason: InstallationLostReason = action === 'deleted' ? 'uninstalled' : 'suspended';
    return { ...base, affected: await markLost(db, installationId, bots.map((b) => b.id), reason, now) };
  }
  if (action === 'unsuspend') {
    const bots = await botsOnInstallation(db, installationId);
    const ids = bots.filter((b) => b.github_installation_lost_reason === 'suspended').map((b) => b.id);
    return { ...base, affected: await clearLost(db, installationId, ids, now) };
  }
  return { ...base, ignored: `action ${action ?? '(none)'} not handled` };
}

/** `installation_repositories` 이벤트: 봇 레포가 목록에서 빠지면 잃어버림, 다시 들어오면 복구 */
export async function handleInstallationRepositoriesEvent(
  db: BotsTable,
  payload: InstallationPayload,
  now = new Date().toISOString(),
): Promise<EventOutcome> {
  const action = payload.action ?? null;
  const installationId = installationIdOf(payload);
  const base = { event: 'installation_repositories', action, installationId, affected: 0 };
  if (!installationId) return { ...base, ignored: 'no installation id' };

  const bots = await botsOnInstallation(db, installationId);
  if (action === 'removed') {
    const removed = fullNames(payload.repositories_removed);
    const ids = bots.filter((b) => {
      const name = repoFullNameOf(b.github_repo_url);
      return name !== null && removed.has(name);
    }).map((b) => b.id);
    return { ...base, affected: await markLost(db, installationId, ids, 'repo_removed', now) };
  }
  if (action === 'added') {
    const added = fullNames(payload.repositories_added);
    const ids = bots.filter((b) => {
      const name = repoFullNameOf(b.github_repo_url);
      return b.github_installation_lost_reason === 'repo_removed' && name !== null && added.has(name);
    }).map((b) => b.id);
    return { ...base, affected: await clearLost(db, installationId, ids, now) };
  }
  return { ...base, ignored: `action ${action ?? '(none)'} not handled` };
}
