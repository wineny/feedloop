// 묶음 목록 — 대시보드의 "묶음" 섹션이 읽는다.
//
// ⚠️ 부작용이 있는 GET 이다(I-10): 밀린 자동 묶기가 있으면 after() 에서 잠금을 잡고 모델을 부른다.
// 인증된 소유자·승인자만 닿고 정상 상태에선 읽기 한 번으로 끝나지만, 새로고침·prefetch 가 곧 묶기 실행일 수 있다.

import { NextRequest, NextResponse, after } from 'next/server';
import { resolveAccessibleBots } from '@/lib/auth/ownership';
import { getServiceRoleClient } from '@/lib/supabase';
import { catchUpAutoGrouping, readGroupingStatus } from '@/lib/groups/auto-grouping';
import { groupPriority, compareGroupPriority, type GroupPriority } from '@/lib/groups/priority';
import type { GroupingStatus } from '@/lib/groups/grouping-status';
import { apiText } from '@/lib/http/api-text';

// 응답은 짧지만 after() 의 밀린 자동 묶기(catch-up)가 최대 100초 돈다.
export const maxDuration = 120;

const EMPTY_STATUS: GroupingStatus = { pending: 0, dueAt: null, running: false, lastGroupedAt: null };

export interface GroupSummary {
  id: string;
  title: string;
  summary: string;
  category: string;
  status: string;
  createdAt: string;
  insightCount: number;
  conversationCount: number;
  priority: GroupPriority;
  pr: { url: string; number: number; mergedAt: string | null } | null;
  /** 기능 요청 묶음의 스펙 초안(마크다운). 아직 안 만들었으면 null. */
  specDraft: string | null;
  followUpPending?: boolean;
}

export async function GET(req: NextRequest) {
  const auth = await resolveAccessibleBots(req.nextUrl.searchParams.get('botId'));
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (auth.botIds.length === 0) return NextResponse.json({ groups: [], grouping: EMPTY_STATUS });

  // I-10 — settle 한 함수가 quiet 를 못 채우고 죽었으면(배포·타임아웃) due 가 남는다.
  // 운영자가 화면을 여는 순간이 따라잡기 좋은 때다. 정상 상태에선 읽기 한 번으로 끝난다.
  // 마감은 «라우트 시작» 기준이다 — after() 는 응답 뒤에 시작하므로 앞단이 먹은 시간을 빼야 maxDuration 안에 든다.
  const catchUpDeadline = Date.now() + 100_000;
  after(catchUpAutoGrouping(auth.botIds, catchUpDeadline).catch((err) => console.error('[groups] catch-up failed:', err)));

  // 상태줄(I-12)용. 못 읽어도 목록은 보여준다 — 마이그레이션이 늦은 배포에서 화면이 통째로 죽지 않게.
  const grouping = await readGroupingStatus(auth.botIds).catch((err) => {
    console.error('[groups] grouping status failed:', err instanceof Error ? err.message : err);
    return null;
  });

  const db = getServiceRoleClient();

  const result: GroupSummary[] = [];
  for (let offset = 0; ; offset += 50) {
    const { data: groups, error } = await db
      .from('insight_groups')
      .select('id, title, summary, category, status, created_at, spec_draft, follow_up_pending, impact_core, impact_reason')
      .in('bot_id', auth.botIds)
      .neq('status', 'dismissed')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + 49);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!groups?.length) break;

    const groupIds = groups.map((g) => g.id);

    // 묶음에 속한 인사이트 → 그 인사이트의 메시지가 속한 대화 수까지 센다.
    // "몇 건이 아니라 몇 명" 이 시연에서 더 중요한 숫자다.
    const [insightsRes, runsRes] = await Promise.all([
      db
        .from('insights')
        .select('id, group_id, message_id, messages(conversation_id)')
        .in('group_id', groupIds),
      db
        .from('auto_dev_runs')
        .select('group_id, pr_url, pr_number, merged_at, closed_at, status, created_at')
        .in('group_id', groupIds)
        .order('created_at', { ascending: false }),
    ]);

    if (insightsRes.error || runsRes.error) return NextResponse.json({ error: apiText(req, 'groupsReadFailed') }, { status: 500 });
    const insightCount = new Map<string, number>();
    const conversations = new Map<string, Set<string>>();
    for (const i of insightsRes.data ?? []) {
      const gid = i.group_id as string;
      insightCount.set(gid, (insightCount.get(gid) ?? 0) + 1);

      // Supabase 조인은 객체 또는 배열로 온다.
      const raw = i.messages as unknown;
      const msg = (Array.isArray(raw) ? raw[0] : raw) as { conversation_id?: string } | null;
      if (msg?.conversation_id) {
        if (!conversations.has(gid)) conversations.set(gid, new Set());
        conversations.get(gid)!.add(msg.conversation_id);
      }
    }

    // 대화 id 를 **사람 키**로 접는다. 위 주석이 선언한 「몇 건이 아니라 몇 명」을 지키려면
    // 한 사람이 대화를 여러 개 열 수 있는 입구를 고려해야 한다 — 채널톡은 유저챗 1개가
    // 대화 1개라 같은 사람이 문의를 세 번 하면 대화가 셋이다.
    // 웹·카카오는 `channel_person_id` 가 NULL 이라 키가 곧 대화 id 이고 결과가 종전과 같다.
    // 조회가 실패해도 폴백이 대화 id 라 숫자가 지금보다 나빠지지는 않는다.
    const allConvIds = [...new Set([...conversations.values()].flatMap((set) => [...set]))];
    const personKey = new Map<string, string>();
    if (allConvIds.length > 0) {
      const { data: convs } = await db
        .from('conversations')
        .select('id, channel_person_id')
        .in('id', allConvIds);
      for (const c of convs ?? []) {
        personKey.set(c.id as string, (c.channel_person_id as string | null) ?? (c.id as string));
      }
    }

    function personCount(gid: string): number {
      const ids = conversations.get(gid);
      if (!ids) return 0;
      return new Set([...ids].map((id) => personKey.get(id) ?? id)).size;
    }

    // 묶음마다 가장 최근 성공 run 하나를 대표로.
    const prOf = new Map<string, GroupSummary['pr']>();
    for (const r of runsRes.data ?? []) {
      const gid = r.group_id as string;
      if (!gid || prOf.has(gid)) continue;
      // 머지 없이 닫힌 PR 은 없는 것으로 친다 — 묶음이 다시 「PR 만들기」 를 받을 수 있게
      if (!r.pr_url || (r.closed_at && !r.merged_at)) continue;
      prOf.set(gid, { url: r.pr_url, number: r.pr_number ?? 0, mergedAt: r.merged_at ?? null });
    }

    result.push(...groups.map((g) => ({
      id: g.id,
      title: g.title,
      summary: g.summary,
      category: g.category,
      status: g.status,
      createdAt: g.created_at,
      insightCount: insightCount.get(g.id) ?? 0,
      conversationCount: personCount(g.id),
      priority: groupPriority(personCount(g.id), insightCount.get(g.id) ?? 0, g.impact_core ?? null, g.impact_reason ?? null),
      pr: prOf.get(g.id) ?? null,
      specDraft: g.spec_draft ?? null,
      followUpPending: g.follow_up_pending ?? false,
    })));
    if (groups.length < 50) break;
  }

  // status도 함께 비교해 반영된 묶음은 점수와 관계없이 뒤로 보낸다.
  result.sort(compareGroupPriority);
  return NextResponse.json({ groups: result.slice(0, 50), grouping });
}
