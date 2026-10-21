// 세션 유저가 소유한 봇으로 쿼리를 좁히는 공통 인가 헬퍼.
//
// 이 프로젝트의 API 라우트는 service_role 클라이언트를 쓰기 때문에 RLS 가 적용되지 않는다.
// 따라서 테넌트 스코핑을 애플리케이션 레벨에서 명시적으로 해야 한다.

import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getServiceRoleClient } from '@/lib/supabase';
import { apiTextInContext } from '@/lib/http/api-text';

/** How a user stands to a bot: its owner (bots.user_id) or an approver added through bot_members. */
export type BotRole = 'owner' | 'approver';

export type OwnedBots =
  | {
      ok: true;
      userId: string;
      botIds: string[];
      /** Set when one bot was asked for (resolveAccessibleBots). Approvers may operate, not configure. */
      role?: BotRole;
    }
  | { ok: false; status: 401 | 403; error: string };

/** Shown to an approver who tries an owner-only action (reply, close, settings). */
export const OWNER_ONLY_ERROR = 'Only the bot owner can do this. Approvers can approve or reject refund requests.';

/**
 * 로그인 여부를 확인하고 그 유저가 가진 봇 id 목록을 돌려준다.
 *
 * @param requestedBotId 클라이언트가 지정한 bot_id (선택).
 *        주면 소유 여부를 검사하고, 안 주면 유저의 봇 전체로 스코핑한다.
 */
export async function resolveOwnedBots(requestedBotId?: string | null): Promise<OwnedBots> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  const db = getServiceRoleClient();
  const { data: bots } = await db.from('bots').select('id').eq('user_id', session.user.id);
  const botIds = (bots ?? []).map((b) => b.id as string);

  if (requestedBotId) {
    if (!botIds.includes(requestedBotId)) {
      return { ok: false, status: 403, error: await apiTextInContext('botForbidden') };
    }
    return { ok: true, userId: session.user.id, botIds: [requestedBotId] };
  }

  return { ok: true, userId: session.user.id, botIds };
}

/**
 * Owner OR approver. `bot_members` (20261019_01) lets people who do not own a bot work its
 * operator screens — the PayPal hackathon demo bot is the first case: a judge presses
 * "Try the demo bot", becomes an approver, and from then on sees its inbox, dashboard and
 * approval cards.
 *
 * Use this ONLY for reading/operating routes (inbox, dashboard, groups, payment approvals).
 * Settings routes (LLM key, knowledge, appearance, channel, delete) keep `resolveOwnedBots`:
 * an approver must not be able to re-key, re-wire or delete a bot they do not own.
 *
 * With a bot id the answer also says the caller's `role`. Routes that let an approver LOOK but
 * not ACT (inbox reply, close) check `role === 'owner'` and answer OWNER_ONLY_ERROR otherwise
 * (stage 3, 6/6): approving is the one thing an approver is for.
 */
export async function resolveAccessibleBots(requestedBotId?: string | null): Promise<OwnedBots> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  const access = await listAccessibleBots(session.user.id);
  const botIds = mergeIds(access);

  if (requestedBotId) {
    if (!botIds.includes(requestedBotId)) {
      return { ok: false, status: 403, error: await apiTextInContext('botForbidden') };
    }
    // Owner wins over a stray membership row for a bot the user also owns.
    const role: BotRole = access.owned.includes(requestedBotId) ? 'owner' : 'approver';
    return { ok: true, userId: session.user.id, botIds: [requestedBotId], role };
  }

  return { ok: true, userId: session.user.id, botIds };
}

/** The bots a user may touch, split by how: owned (configure + operate) and approver-only (operate). */
export interface AccessibleBots {
  owned: string[];
  /** bot_members rows for bots the user does NOT own. */
  approver: string[];
}

export async function listAccessibleBots(userId: string): Promise<AccessibleBots> {
  const db = getServiceRoleClient();
  const [owned, member] = await Promise.all([
    db.from('bots').select('id').eq('user_id', userId),
    db.from('bot_members').select('bot_id').eq('user_id', userId),
  ]);
  // A failed lookup must not look like "this user has no bots": routes turn this into a 500.
  if (owned.error) throw new Error(`bots lookup failed: ${owned.error.message}`);
  if (member.error) throw new Error(`bot_members lookup failed: ${member.error.message}`);
  const ownedIds: string[] = [];
  for (const b of owned.data ?? []) {
    const id = b.id as string;
    if (!ownedIds.includes(id)) ownedIds.push(id);
  }
  const approverIds: string[] = [];
  for (const m of member.data ?? []) {
    const id = m.bot_id as string;
    if (!ownedIds.includes(id) && !approverIds.includes(id)) approverIds.push(id);
  }
  return { owned: ownedIds, approver: approverIds };
}

function mergeIds(access: AccessibleBots): string[] {
  return [...access.owned, ...access.approver];
}

/** Bot ids a user owns, followed by the ones they were added to as an approver (deduplicated). */
export async function listAccessibleBotIds(userId: string): Promise<string[]> {
  return mergeIds(await listAccessibleBots(userId));
}
