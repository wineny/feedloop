// 어느 GitHub 자격으로 갈 것인가 — **설치(GitHub App) → 봇 토큰(PAT) → 플랫폼 공용 `GITHUB_TOKEN`** 순 (B5 + 안 B).
//
// Octokit 을 만드는 곳이 셋(엔진·머지 감지·PR 검토)인데 전부 여기를 탄다.
// 한 곳이라도 `process.env.GITHUB_TOKEN` 을 직접 읽으면 운영자 자격을 넣은 봇이 그 경로에서만
// 공용 계정으로 나가 「내 레포인데 왜 403 이냐」가 된다.
//
// 설치 경로: 봇에 `github_installation_id` 가 있고(잃어버림 표시 없이) 앱 env 가 있으면 설치 토큰(1시간, auth-app 이 갱신)으로
// 간다. PR·커밋은 `<slug>[bot]` 이름이다. 호출부가 `repoUrl` 을 주면 그 레포의 소유자가 설치 계정과 다를 때 설치를 건너뛴다 —
// run-access 가 옛 PR 을 `pr_url` 의 레포(예: 데모 레포)에서 읽는데 설치는 라이브 레포에만 있을 수 있다.
//
// 봇 토큰이 GitHub 에서 거부되면(401/403) `github_token_failed_at` 에 적어 화면이 「토큰 확인 필요」를
// 띄우게 한다. 공용 토큰의 실패는 봇에 적지 않는다 — 운영자가 고칠 수 있는 게 아니다.
// 설치 경로의 실패도 «적지 않는다» — 잃어버림은 웹훅(installation.deleted/suspend·repo 제거)이 정본이고,
// 403 은 브랜치 보호·권한 재승인 대기처럼 운영자가 GitHub 쪽에서 고칠 일이라 배지 대신 실행 로그에 남긴다.
// 404 는 «적지 않는다» — 지워진 PR · 권한 없는 비공개 레포 · «다른 레포의 옛 PR»(run-access 가 pr_url 의 레포를
// 우선하므로 봇을 다른 레포로 옮긴 뒤 옛 PR 을 열면 봇 토큰이 그 레포를 모른다)을 구분 못 해 멀쩡한 토큰에
// 배지가 켜지고, 상세 폴링(60초)이 매번 다시 찍어 영영 안 꺼진다(코드 리뷰 HIGH).

import { Octokit } from '@octokit/rest';
import { getServiceRoleClient } from '@/lib/supabase';
import { decrypt } from '@/lib/utils/crypto';
import { classifyGithubFailure, githubFailureMessage, type GithubFailureKind } from '@/lib/github/token';
import { installationOctokit, readGithubAppConfig } from '@/lib/github/app';
import { parseRepoInfo } from '@/lib/github/repo-url';

export type TokenSource = 'installation' | 'bot' | 'platform';

export interface ResolvedGithubToken {
  token: string;
  source: Exclude<TokenSource, 'installation'>;
}

export interface GithubAuthOptions {
  /** 이 호출이 향하는 레포. 설치 계정과 소유자가 다르면 설치 대신 토큰으로 간다 */
  repoUrl?: string | null;
  /** 그 호출에만 요청 타임아웃. 기본값으로 올리면 엔진의 getTree 같은 큰 호출이 같이 잘린다 */
  timeoutMs?: number;
  /** 전체 작업 마감. 개별 요청 제한과 함께 실제 HTTP 요청을 취소한다. */
  signal?: AbortSignal;
  /** 엔진이 실행권·생성 예산을 GitHub 호출마다 강제하려고 갈아끼운다 */
  fetch?: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

interface BotAuthRow {
  github_token_encrypted?: string | null;
  github_installation_id?: number | string | null;
  github_installation_login?: string | null;
  github_installation_lost_at?: string | null;
}

const AUTH_SELECT = 'github_token_encrypted, github_installation_id, github_installation_login, github_installation_lost_at';

/**
 * 봇 행의 자격 컬럼을 읽는다. 조회가 «실패»하면 공용으로 흘리지 않고 throw —
 * 운영자 자격이 있는데 공용 계정으로 push 가 나가면 운영자가 토큰을 회수해도 push 가 계속되고,
 * 마이그레이션이 빠진 환경은 기능 전체가 소리 없이 공용으로 내려앉는다(보안 리뷰 M1, I-23 과 같은 fail-closed).
 * 우리 쪽 장애라 운영자 배지(failed_at)는 켜지 않는다.
 */
async function loadBotAuthRow(botId: string): Promise<BotAuthRow | null> {
  const { data, error } = await getServiceRoleClient().from('bots').select(AUTH_SELECT).eq('id', botId).maybeSingle();
  if (error) {
    console.error('[github-auth] bot auth lookup failed', { botId, message: error.message });
    throw new Error('GitHub 연결 설정을 읽지 못했어요. 잠시 후 다시 시도해 주세요');
  }
  return (data as BotAuthRow | null) ?? null;
}

function installationIdOf(row: BotAuthRow | null): number | null {
  if (!row || row.github_installation_lost_at) return null;
  const raw = row.github_installation_id;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 설치 계정과 레포 소유자가 같은가. **애매하면 «아니다»** — 설치 토큰은 그 계정의 레포들에 쓸 수 있으므로
 * 확신이 없을 때 설치로 가면 우리가 검증하지 않은 레포에 push 할 수 있다(보안 리뷰 M3).
 * 여기서 false 가 나오면 기능이 죽는 게 아니라 봇 토큰·공용 토큰으로 내려갈 뿐이다.
 *
 * `repoUrl` 을 «안 준» 호출(botId 만)은 예외다 — 어느 레포로 갈지 모르는 호출이라 좁힐 근거가 없고,
 * 지금 호출부 넷은 전부 repoUrl 을 준다.
 */
function installationCoversRepo(row: BotAuthRow, repoUrl: string | null | undefined): boolean {
  if (repoUrl === undefined) return true;
  if (!repoUrl) return false;
  const login = row.github_installation_login?.trim();
  if (!login) return false;
  try {
    return parseRepoInfo(repoUrl).owner.toLowerCase() === login.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * 봇 행의 암호문을 풀어 쓰고, 없으면 공용으로. 둘 다 없으면 throw — 예전과 같은 문구라 호출부가 안 바뀐다.
 * `botId` 를 안 주면(실측 스크립트 등) 공용만 본다. **설치 경로는 여기 없다** — 설치는 토큰이 아니라 인증 전략이라
 * `octokitForBot` 만 안다. 문자열 토큰이 필요한 호출부(없음)가 생기면 그때 설치 토큰 발급을 따로 만든다.
 */
export async function resolveGithubToken(botId?: string | null, row?: BotAuthRow | null): Promise<ResolvedGithubToken> {
  if (botId) {
    const data = row === undefined ? await loadBotAuthRow(botId) : row;
    const encrypted = data?.github_token_encrypted;
    if (encrypted) {
      const token = decrypt(encrypted);
      if (token) return { token, source: 'bot' };
      // 암호문이 손상됐다(AES 키 교체 등). GitHub 이 거부한 게 아니라 «우리가 못 읽은» 것이라 사유를 가른다 —
      // 조치(다시 등록)는 같지만 실패 통계에 섞이면 안 된다
      await recordGithubFailure(botId, 'unreadable');
      throw new Error('봇의 GitHub 토큰을 읽지 못했어요. 토큰을 다시 등록해 주세요');
    }
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN이 설정되지 않았습니다');
  return { token, source: 'platform' };
}

/**
 * 토큰·설치 결정은 여기 한 곳에서만 한다(B5 + 안 B). 호출부가 다른 것이 필요하면 옵션으로 받는다 —
 * 각자 `new Octokit` 을 만들면 그 경로에서만 공용 계정으로 새기 때문이다.
 */
export async function octokitForBot(
  botId?: string | null,
  opts: GithubAuthOptions = {},
): Promise<{ octokit: Octokit; source: TokenSource }> {
  const request: { timeout?: number; fetch?: GithubAuthOptions['fetch'] } = {};
  if (opts.timeoutMs) request.timeout = opts.timeoutMs;
  if (opts.fetch) request.fetch = opts.fetch;
  if (opts.signal || opts.timeoutMs) {
    const transport = opts.fetch ?? globalThis.fetch;
    request.fetch = (url, init) => {
      // A fresh timer per request; the shared signal bounds the entire pagination/gate.
      const signals = [opts.signal, init?.signal, opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined]
        .filter((s): s is AbortSignal => Boolean(s));
      const signal = AbortSignal.any(signals);
      signal.throwIfAborted();
      return transport(url, { ...init, signal });
    };
  }
  const extra = Object.keys(request).length ? { request } : {};
  if (botId) {
    const row = await loadBotAuthRow(botId);
    const installationId = installationIdOf(row);
    if (installationId && row && installationCoversRepo(row, opts.repoUrl)) {
      const config = readGithubAppConfig();
      if (config) {
        return { octokit: installationOctokit(config, installationId, request), source: 'installation' };
      }
      // 설치는 기록돼 있는데 앱 env 가 없다 — 배포 env 누락. 조용히 PAT 로 내려가면 «feedloop[bot] 이어야 할 PR 이
      // 다른 이름으로» 열려 운영자가 원인을 모른다. health 가 잡도록 로그를 남기고 토큰 경로로 간다
      console.error('[github-auth] installation recorded but GitHub App env missing', { botId, installationId });
    }
    const { token, source } = await resolveGithubToken(botId, row);
    return { octokit: new Octokit({ auth: token, ...extra }), source };
  }
  const { token, source } = await resolveGithubToken(botId);
  return { octokit: new Octokit({ auth: token, ...extra }), source };
}

/** Octokit 이 던지는 에러의 HTTP 상태. 없으면 null */
export function githubStatusOf(err: unknown): number | null {
  const s = (err as { status?: unknown })?.status;
  return typeof s === 'number' ? s : null;
}

/**
 * 봇 토큰으로 간 호출이 거부됐을 때만 적는다. 그 외(5xx·네트워크)는 일시 장애라 배지를 켜지 않는다.
 * 사유는 고정 문구 3분류만 — GitHub 에러 원문은 키 조각을 품을 수 있어 넣지 않는다.
 */
export async function recordGithubFailure(botId: string, kind: GithubFailureKind): Promise<void> {
  const { error } = await getServiceRoleClient()
    .from('bots')
    .update({ github_token_failed_at: new Date().toISOString(), github_token_failed_reason: githubFailureMessage(kind) })
    .eq('id', botId);
  if (error) console.error('[github-auth] failure record failed', { botId, message: error.message });
}

/**
 * 봇 토큰 경로에서 난 에러를 판정해 기록한다. 공용·설치 경로면 DB 엔 아무것도 안 한다(설치는 warn 한 줄).
 * `write: true` 면 «읽기는 됐는데 쓰기(브랜치·커밋·PR·머지)에서 403» 이라는 뜻이라 no_push 로 적는다 —
 * 운영자가 고칠 것은 레포 접근이 아니라 Read/Write 토글이다(코드 리뷰 HIGH). 확실한 401/403 만 적는다
 */
export async function noteGithubError(
  botId: string | null | undefined,
  source: TokenSource,
  err: unknown,
  opts: { write?: boolean } = {},
): Promise<void> {
  if (!botId) return;
  const status = githubStatusOf(err);
  if (source === 'installation') {
    if (status === 401 || status === 403) console.warn('[github-auth] installation call rejected', { botId, status, write: Boolean(opts.write) });
    return;
  }
  if (source !== 'bot') return;
  if (status !== 401 && status !== 403) return;
  await recordGithubFailure(botId, opts.write && status === 403 ? 'no_push' : classifyGithubFailure(status));
}

/**
 * 봇 토큰으로 성공했으면 지난 실패 표시를 지운다 — failed_at 이 있을 때만 UPDATE 한다(성공마다 쓰면 왕복이 는다).
 */
export async function clearGithubFailureIfAny(botId: string | null | undefined, source: TokenSource): Promise<void> {
  if (!botId || source !== 'bot') return;
  const { error } = await getServiceRoleClient()
    .from('bots')
    .update({ github_token_failed_at: null, github_token_failed_reason: null })
    .eq('id', botId)
    .not('github_token_failed_at', 'is', null);
  if (error) console.error('[github-auth] failure clear failed', { botId, message: error.message });
}
