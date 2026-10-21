// 수정 PR 목록 — /monitor 화면의 왼쪽 목록과 상세가 읽는다.
//
// 예전 모니터는 `?runId=` 하나의 스트림만 보여줘서 "지금까지 어떤 PR 이 올라갔고, 머지돼서
// 누구에게 되돌림이 갔는지"를 볼 자리가 없었다. 실행(auto_dev_runs) 마다 근거 묶음·PR·
// 되돌림(responses.loop_closed) 을 한 번에 붙여 돌려준다.

import type { PickedShotData } from '@/lib/widget/picked-shot';
import { NextRequest, NextResponse } from 'next/server';
import { resolveOwnedBots } from '@/lib/auth/ownership';
import { getServiceRoleClient } from '@/lib/supabase';
import type { ValidationEvidence } from '@/lib/auto-dev/validation';
import type { CloseReason } from '@/lib/auto-dev/close-reason';
import { parseStoredExplanation, type RunExplanation } from '@/lib/auto-dev/explanation';
import { personLabelFor } from '@/lib/channel/labels-server';
import { localeFromRequest } from '@/i18n/server-locale';
import type { Locale } from '@/i18n/routing';
import { apiText } from '@/lib/http/api-text';

export interface RunReturn {
  conversationId: string;
  source: string;
  name: string;
  /** 대기열(카카오)이면 null — 그 유저가 다음에 말을 걸 때 나간다 */
  deliveredAt: string | null;
  confirmation: 'fixed' | 'not_fixed' | null;
  confirmedAt: string | null;
  /** 이메일로도 나갔으면 그 시각. 연락처에 이메일이 없거나 실패면 null */
  emailSentAt: string | null;
  emailDeliveryStatus?: string;
  emailError?: string | null;
}

export interface RunItem {
  id: string;
  status: 'running' | 'in_progress' | 'completed' | 'failed' | 'stopped' | 'unverifiable';
  validationStatus?: string;
  validationEvidence?: ValidationEvidence | null;
  publicationStatus?: string;
  stopReason?: string | null;
  deploymentStatus?: string;
  deploymentReason?: string | null;
  followUpError?: string | null;
  createdAt: string;
  durationMs: number | null;
  title: string;
  category: string | null;
  repo: string | null;
  pr: {
    url: string;
    number: number;
    mergedAt: string | null;
    closedAt: string | null;
    /** 머지 없이 닫힌 이유 — 사람이 고른다. null = 미분류 */
    closeReason: CloseReason | null;
    closeNote: string | null;
  } | null;
  filesChanged: { path: string; action: string }[];
  errorMessage: string | null;
  evidence: { insightCount: number; conversationCount: number };
  returns: RunReturn[];
  /** 담당자용 설명 (I-19). 이 기능 전 실행은 null — 화면이 PR 본문에서 뽑은 것을 대신 쓴다 */
  explanation: RunExplanation | null;
  /** 데모(로그아웃 심사 화면) 전용 — 근거 제보가 짚은 화면. 실제 실행은 /pr 라우트가 서명 URL 로 싣는다 */
  demoPickedShots?: PickedShotData[];
}

/** Supabase 조인은 객체 또는 배열로 온다 — 첫 번째 하나로 접는다. */
function one<T>(v: unknown): T | null {
  if (Array.isArray(v)) return (v[0] as T) ?? null;
  return (v as T) ?? null;
}

/**
 * 연락처를 안 남긴 사람은 식별자 앞 4자로 부른다(대화 화면과 같은 규칙).
 *
 * 호칭은 `lib/channel/labels` 하나를 본다. 여기에 맵을 따로 두면 입구가 늘 때
 * 한 군데가 빠지고, 채널톡 이용자가 「방문자 #」로 잘못 불린다 — 운영자가
 * 되돌림이 어디로 갔는지 화면만 보고 알 수 없게 된다.
 */
function displayName(c: { contact_name: string | null; external_user_id: string; source: string }, locale: Locale): string {
  if (c.contact_name) return c.contact_name;
  return `${personLabelFor(c.source, locale)} #${c.external_user_id.slice(0, 4)}`;
}

export async function GET(req: NextRequest) {
  const auth = await resolveOwnedBots(req.nextUrl.searchParams.get('botId'));
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (auth.botIds.length === 0) return NextResponse.json({ runs: [] });

  const db = getServiceRoleClient();

  const { data: runs, error } = await db
    .from('auto_dev_runs')
    .select(
      `id, status, created_at, duration_ms, pr_url, pr_number, merged_at, closed_at, close_reason, close_note, files_changed, error_message,
       explanation, group_id, insight_id, validation_status, validation_evidence, publication_status, stop_reason, deployment_status, deployment_reason, follow_up_error,
       insight_groups ( title, category ),
       insights ( summary, category, messages ( conversation_id ) ),
       bots ( github_repo_url )`,
    )
    .in('bot_id', auth.botIds)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!runs || runs.length === 0) return NextResponse.json({ runs: [] });

  const runIds = runs.map((r) => r.id as string);
  const groupIds = runs.map((r) => r.group_id as string | null).filter((g): g is string => Boolean(g));

  const [returnsRes, evidenceRes] = await Promise.all([
    db
      .from('responses')
      .select(
        `auto_dev_run_id, conversation_id, delivered_at, user_confirmation, user_confirmed_at, sent_at, email_sent_at, email_delivery_status, email_error,
         conversations ( contact_name, external_user_id, source )`,
      )
      .in('auto_dev_run_id', runIds)
      .eq('response_type', 'loop_closed')
      .order('sent_at', { ascending: true }),
    groupIds.length > 0
      ? db.from('insights').select('group_id, messages(conversation_id)').in('group_id', groupIds)
      : Promise.resolve({ data: [] as { group_id: string; messages: unknown }[], error: null }),
  ]);

  if (returnsRes.error || evidenceRes.error) return NextResponse.json({ error: apiText(req, 'evidenceReadFailed') }, { status: 500 });

  // 묶음별 근거 — 인사이트 몇 건, 대화 몇 개
  const insightCount = new Map<string, number>();
  const convSets = new Map<string, Set<string>>();
  for (const i of evidenceRes.data ?? []) {
    const gid = i.group_id as string;
    insightCount.set(gid, (insightCount.get(gid) ?? 0) + 1);
    const msg = one<{ conversation_id?: string }>(i.messages);
    if (msg?.conversation_id) {
      if (!convSets.has(gid)) convSets.set(gid, new Set());
      convSets.get(gid)!.add(msg.conversation_id);
    }
  }

  const returnsByRun = new Map<string, RunReturn[]>();
  for (const r of returnsRes.data ?? []) {
    const rid = r.auto_dev_run_id as string;
    const conv = one<{ contact_name: string | null; external_user_id: string; source: string }>(r.conversations);
    if (!conv || !r.conversation_id) continue;
    const list = returnsByRun.get(rid) ?? [];
    list.push({
      conversationId: r.conversation_id as string,
      source: conv.source,
      name: displayName(conv, localeFromRequest(req)),
      deliveredAt: (r.delivered_at as string | null) ?? null,
      confirmation: (r.user_confirmation as RunReturn['confirmation']) ?? null,
      confirmedAt: (r.user_confirmed_at as string | null) ?? null,
      emailSentAt: (r.email_sent_at as string | null) ?? null,
      emailDeliveryStatus: r.email_delivery_status as string,
      emailError: r.email_error as string | null,
    });
    returnsByRun.set(rid, list);
  }

  const result: RunItem[] = runs.map((r) => {
    const group = one<{ title: string; category: string }>(r.insight_groups);
    const insight = one<{ summary: string; category: string; messages?: unknown }>(r.insights);
    const insightConv = one<{ conversation_id?: string | null }>(insight?.messages)?.conversation_id;
    const bot = one<{ github_repo_url: string | null }>(r.bots);
    const gid = r.group_id as string | null;
    const status = (r.status as RunItem['status']) ?? 'running';
    const returns = returnsByRun.get(r.id as string) ?? [];

    return {
      id: r.id as string,
      status: status === 'in_progress' ? 'running' : status,
      validationStatus: r.validation_status ?? 'unknown',
      validationEvidence: r.validation_evidence as ValidationEvidence | null,
      publicationStatus: r.publication_status,
      stopReason: r.stop_reason,
      deploymentStatus: r.deployment_status ?? 'unknown',
      deploymentReason: r.deployment_reason,
      followUpError: r.follow_up_error,
      createdAt: r.created_at as string,
      durationMs: (r.duration_ms as number | null) ?? null,
      title: group?.title ?? insight?.summary ?? apiText(req, 'autoFixRun'),
      category: group?.category ?? insight?.category ?? null,
      repo: bot?.github_repo_url?.replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '') ?? null,
      pr:
        r.pr_url
          ? {
              url: r.pr_url as string,
              number: (r.pr_number as number) ?? 0,
              mergedAt: (r.merged_at as string | null) ?? null,
              closedAt: (r.closed_at as string | null) ?? null,
              closeReason: (r.close_reason as CloseReason | null) ?? null,
              closeNote: (r.close_note as string | null) ?? null,
            }
          : null,
      filesChanged: Array.isArray(r.files_changed) ? (r.files_changed as RunItem['filesChanged']) : [],
      errorMessage: (r.error_message as string | null) ?? null,
      evidence: {
        // 묶음이 아니라 인사이트 하나로 돈 실행이면 근거는 그 한 건이다
        insightCount: gid ? insightCount.get(gid) ?? 0 : r.insight_id ? 1 : 0,
        // 인사이트 하나로 돈 실행도 그 제보를 남긴 사람은 한 명이다 — 「0명에게 알려요」라고 하면 안 된다
        conversationCount: gid ? convSets.get(gid)?.size ?? 0 : insightConv ? 1 : 0,
      },
      returns,
      explanation: parseStoredExplanation(r.explanation),
    };
  });

  return NextResponse.json({ runs: result });
}
