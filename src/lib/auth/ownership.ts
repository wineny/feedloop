// 세션 유저가 소유한 봇으로 쿼리를 좁히는 공통 인가 헬퍼.
//
// 이 프로젝트의 API 라우트는 service_role 클라이언트를 쓰기 때문에 RLS 가 적용되지 않는다.
// 따라서 테넌트 스코핑을 애플리케이션 레벨에서 명시적으로 해야 한다.

import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getServiceRoleClient } from '@/lib/supabase';

export type OwnedBots =
  | { ok: true; userId: string; botIds: string[] }
  | { ok: false; status: 401 | 403; error: string };

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
      return { ok: false, status: 403, error: '해당 봇에 대한 권한이 없습니다' };
    }
    return { ok: true, userId: session.user.id, botIds: [requestedBotId] };
  }

  return { ok: true, userId: session.user.id, botIds };
}
