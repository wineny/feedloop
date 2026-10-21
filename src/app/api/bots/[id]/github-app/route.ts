// 봇 설정 › GitHub 연결 › «Feedloop 앱 설치» 상태 (안 B). 화면이 읽고, 다시 확인하고, 연결을 푼다.
//
//  GET    — 설치 여부·계정·설치 URL(서명된 state 포함)·잃어버림 사유. 비밀은 없다(설치 id 는 비밀이 아니다)
//  POST   — 「설치 확인」: 이미 묶인 설치가 아직 그 레포에 있는지 앱 JWT 로 다시 본다. **새로 묶지 않는다**(유저 토큰이 없다)
//  DELETE — 우리 쪽 기록만 지운다. GitHub 의 설치 자체는 운영자가 GitHub 설정에서 제거한다(링크 제공)
//
// 새로 묶는 경로는 설치 버튼 → GitHub → /api/github/app/callback 하나뿐이다.

import { NextResponse } from 'next/server';
import { resolveOwnedBots } from '@/lib/auth/ownership';
import { getServiceRoleClient } from '@/lib/supabase';
import {
  githubAppAuthorizeUrl,
  githubAppBotLogin,
  githubAppInstallUrl,
  githubInstallationManageUrl,
  installationLostMessage,
  readGithubAppConfig,
} from '@/lib/github/app';
import { installStateSecret, signInstallState } from '@/lib/github/install-state';
import { recheckInstallation } from '@/lib/github/installation-binding';
// 화면과 함께 보는 모양은 «서버가 아닌» 모듈에 있다 — 클라이언트가 라우트 파일을 import 하지 않게(코드 리뷰 MEDIUM)
import type { GithubAppState } from '@/lib/github/app-state-types';
import { apiText } from '@/lib/http/api-text';

export const dynamic = 'force-dynamic';

// 「설치 확인」은 GitHub 호출 1회. 사용자당 분당 10회 — 버튼 연타로 앱 JWT 한도(설치 조회는 앱 단위)를 태우지 않게
const RECHECK_LIMIT_PER_MIN = 10;
const recheckHits = new Map<string, number[]>();
function recheckRateExceeded(userId: string): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;
  const hits = (recheckHits.get(userId) ?? []).filter((t) => t > cutoff);
  hits.push(now);
  recheckHits.set(userId, hits);
  if (recheckHits.size > 5000) {
    for (const [key, times] of recheckHits) if (times.every((t) => t <= cutoff)) recheckHits.delete(key);
  }
  return hits.length > RECHECK_LIMIT_PER_MIN;
}

const SELECT =
  'id, github_repo_url, github_installation_id, github_installation_login, github_installation_connected_at, github_installation_lost_at, github_installation_lost_reason, github_installation_by, github_installation_repo_selection, github_token_last4';

interface BotAppRow {
  id: string;
  github_repo_url: string | null;
  github_installation_id: number | string | null;
  github_installation_login: string | null;
  github_installation_connected_at: string | null;
  github_installation_lost_at: string | null;
  github_installation_lost_reason: string | null;
  github_installation_by: string | null;
  github_installation_repo_selection: string | null;
  github_token_last4: string | null;
}

function installationIdOf(row: BotAppRow): number | null {
  const raw = row.github_installation_id;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

function present(row: BotAppRow, userId: string): GithubAppState {
  const config = readGithubAppConfig();
  const installationId = installationIdOf(row);
  const lost = Boolean(row.github_installation_lost_at);
  const secret = installStateSecret();
  const state = secret ? signInstallState({ botId: row.id, userId }, secret) : null;
  return {
    configured: config !== null,
    botLogin: config ? githubAppBotLogin(config.slug) : null,
    repoUrl: row.github_repo_url,
    installed: installationId !== null && !lost,
    installationId,
    installationLogin: row.github_installation_login,
    connectedAt: row.github_installation_connected_at,
    connectedBy: row.github_installation_by,
    lostAt: row.github_installation_lost_at,
    lostReason: row.github_installation_lost_reason,
    lostMessage: lost ? installationLostMessage(row.github_installation_lost_reason) : null,
    installUrl: config ? githubAppInstallUrl(config.slug, state) : null,
    authorizeUrl: config ? githubAppAuthorizeUrl(config, state) : null,
    manageUrl: installationId ? githubInstallationManageUrl(installationId) : null,
    hasToken: Boolean(row.github_token_last4),
    repositorySelection:
      row.github_installation_repo_selection === 'all' || row.github_installation_repo_selection === 'selected'
        ? row.github_installation_repo_selection
        : null,
  };
}

async function loadBot(id: string): Promise<BotAppRow | null> {
  const { data, error } = await getServiceRoleClient().from('bots').select(SELECT).eq('id', id).single();
  if (error) console.error('[github-app] bot lookup failed', { id, message: error.message });
  return error || !data ? null : (data as unknown as BotAppRow);
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await resolveOwnedBots(id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const bot = await loadBot(id);
  if (!bot) return NextResponse.json({ error: apiText(req, 'botNotFound') }, { status: 404 });
  return NextResponse.json(present(bot, auth.userId));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await resolveOwnedBots(id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (recheckRateExceeded(auth.userId)) {
    return NextResponse.json({ error: apiText(req, 'checkTooFrequent') }, { status: 429 });
  }
  const config = readGithubAppConfig();
  if (!config) return NextResponse.json({ error: apiText(req, 'githubAppNotConfigured') }, { status: 503 });
  const bot = await loadBot(id);
  if (!bot) return NextResponse.json({ error: apiText(req, 'botNotFound') }, { status: 404 });

  let outcome: Awaited<ReturnType<typeof recheckInstallation>>;
  try {
    outcome = await recheckInstallation(config, { id: bot.id, repoUrl: bot.github_repo_url, installationId: installationIdOf(bot) });
  } catch (err) {
    console.error('[github-app] recheck failed', { id, message: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: apiText(req, 'githubAskFailed') }, { status: 502 });
  }
  const after = await loadBot(id);
  if (!after) return NextResponse.json({ error: apiText(req, 'botNotFound') }, { status: 404 });
  return NextResponse.json({ ...present(after, auth.userId), recheck: outcome.kind });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await resolveOwnedBots(id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { error } = await getServiceRoleClient()
    .from('bots')
    .update({
      github_installation_id: null,
      github_installation_login: null,
      github_installation_connected_at: null,
      github_installation_repo_selection: null,
      github_installation_lost_at: null,
      github_installation_lost_reason: null,
      github_installation_by: null,
    })
    .eq('id', id);
  if (error) return NextResponse.json({ error: apiText(req, 'disconnectFailed') }, { status: 500 });
  const bot = await loadBot(id);
  if (!bot) return NextResponse.json({ error: apiText(req, 'botNotFound') }, { status: 404 });
  return NextResponse.json(present(bot, auth.userId));
}
