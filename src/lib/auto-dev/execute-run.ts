// auto_dev_runs 한 건을 실제로 실행하는 공통 경로.
//
// 원래 /api/auto-dev/stream 안에 있던 것을 꺼냈다. 자동 PR 크론(/api/cron/auto-pr)도
// 같은 run 을 돌려야 하는데, 크론은 SSE 로 흘려보낼 상대가 없다.
// 실행권 획득(CAS)·대상 구성·결과 저장은 호출처가 어디든 똑같아야 한다 —
// 여기가 다르면 크론이 만든 PR 과 버튼이 만든 PR 이 다른 규칙을 타게 된다.

import { getServiceRoleClient } from '@/lib/supabase';
import { loadTrustedValidationConfig } from './validation-config';
import type { GenerationBudget } from './validation-budget';
import { digest, type PublicationIntent, type ValidationEvidence, type ValidationTarget } from './validation';
import { callAutoDev } from '@/lib/auto-dev/ai-engine';
import { AutoDevError } from './errors';
import {
  formatContextForPrompt,
  mergeContextsForPrompt,
  collectContextItems,
} from '@/lib/widget/context';
import type { ContextItems } from '@/lib/widget/verify-context';
import { appendSupplements, loadSupplementBodies } from '@/lib/insights/supplements';
import type { RunExplanation } from '@/lib/auto-dev/explanation';

// Supabase 조인 결과는 단일 객체 또는 배열로 온다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function one<T>(raw: any): T | null {
  if (!raw) return null;
  return (Array.isArray(raw) ? raw[0] : raw) ?? null;
}

export const RUN_SELECT = `
  id, bot_id, insight_id, group_id, status, pr_url, pr_number, files_changed, error_message, stop_reason, validation_status, validation_evidence, publication_intent, publication_status, generation_budget,
  insights(category, summary, group_id, message_id, source_message_ids, messages(body, context)),
  insight_groups(title, summary, category, status, follow_up_pending),
  bots(github_repo_url, user_id)
`;

export interface LoadedRun {
  id: string;
  bot_id: string;
  insight_id: string | null;
  group_id: string | null;
  status: string;
  pr_url: string | null;
  pr_number: number | null;
  files_changed: object[] | null;
  error_message: string | null;
  stop_reason?: string | null;
  validation_status?: string;
  publication_status?: string;
  validation_evidence?: unknown;
  publication_intent?: unknown;
  generation_budget?: unknown;
  insights: unknown;
  insight_groups: unknown;
  bots: unknown;
}

export interface RunResult {
  pr_url: string;
  pr_number: number;
  files_changed: { path: string; action: string }[];
  /** 담당자용 설명 (I-19). 모델이 형식을 어기면 null */
  explanation: RunExplanation | null;
}

function db() {
  return getServiceRoleClient();
}

export async function loadRun(runId: string): Promise<LoadedRun | null> {
  const { data, error } = await db()
    .from('auto_dev_runs')
    .select(RUN_SELECT)
    .eq('id', runId)
    .single();
  if (error || !data) return null;
  return data as unknown as LoadedRun;
}

/**
 * 실행권 획득 (compare-and-swap).
 * 'running' 인 run 만 'in_progress' 로 넘길 수 있으므로 동시/중복 요청 중 하나만 통과한다.
 * 이게 없으면 /monitor?runId=... 를 새로고침할 때마다 PR 이 하나씩 더 생긴다.
 */
export async function claimRun(runId: string): Promise<string | null> {
  const {data,error}=await db().rpc('claim_pipeline_run',{p_id:runId});
  if(error) throw new Error(error.message);
  return typeof data === 'string' ? data : null;
}

/** 한 묶음의 대표 원문 몇 건을 모아 프롬프트용 본문과 기술 맥락을 만든다. */
const GROUP_BODY_LIMIT = 5;
const GROUP_BODY_CHARS = 250;

// I-05 — 위젯 즉답이 꼬리질문 답을 기존 인사이트 갱신(source_message_ids)으로 흡수하므로,
// PR 엔진이 읽는 원문도 첫 턴 하나가 아니라 보충 턴까지 봐야 한다(설계 §H).
// 본문을 모으고 덧붙이는 규칙은 `lib/insights/supplements.ts` 하나다 — 스펙 초안
// 경로(`groups/spec.ts`)도 같은 것을 써야 같은 묶음이 경로에 따라 다르게 안 읽힌다.

async function collectGroupEvidence(
  groupId: string,
  fallback: string,
  botId: string,
): Promise<{ body: string; context: string; contextItems: ContextItems }> {
  const { data, error } = await db()
    .from('insights')
    .select('summary, source_message_ids, messages(body, context)')
    .eq('group_id', groupId)
    .order('id', {ascending:true})
    .limit(GROUP_BODY_LIMIT);

  if(error) throw new Error(`evidence lookup: ${error.message}`);
  const rows = data ?? [];

  const bodies = (
    await Promise.all(
      rows.map(async (i) => {
        const primary = one<{ body?: string }>(i.messages)?.body ?? i.summary;
        if (typeof primary !== 'string' || primary.trim() === '') return null;
        const truncated =
          primary.length > GROUP_BODY_CHARS ? `${primary.slice(0, GROUP_BODY_CHARS)}…` : primary;
        const supplements = await loadSupplementBodies(i.source_message_ids as string[] | null, botId);
        return appendSupplements(truncated, supplements);
      }),
    )
  ).filter((b): b is string => b !== null);

  // 제보마다 다른 페이지·에러가 실려 온다. 겹치는 것은 횟수로 남긴다.
  const raws = rows.map((i) => one<{ context?: unknown }>(i.messages)?.context);
  const context = mergeContextsForPrompt(raws);
  // 원자료도 같이 넘긴다 — 엔진이 레포 트리와 대조하려면 문자열로는 안 된다.
  const contextItems = collectContextItems(raws);

  if (bodies.length === 0) return { body: fallback, context, contextItems };
  return {
    body: `${fallback}\n\n${bodies.length} actual reports:\n${bodies.map((b) => `- ${b}`).join('\n')}`,
    context,
    contextItems,
  };
}

/** Read-only operator provisioning helper: exactly the evidence production will send. */
export async function resolveRunValidationInput(run: LoadedRun) {
  const group = one<{title:string;summary:string;category:string}>(run.insight_groups);
  const insight = one<{category:string;summary:string;source_message_ids?:string[]|null;messages?:{body?:string;context?:unknown}}>(run.insights);
  if ((run.group_id ? !group : !insight) || (!run.group_id && !run.insight_id)) throw new Error('insufficient_evidence');
  let target: {
    category: string;
    summary: string;
    message_body: string;
    context?: string;
    contextItems?: ContextItems;
  };

  if (group) {
    // 묶음은 여러 사람이 같은 문제를 말한 것이다. 대표 원문을 함께 넣어야
    // 모델이 증상을 구체적으로 본다. 다만 2-pass 프롬프트가 커지면
    // 함수 시간이 한도에 닿으므로 5건으로 자른다 (설계 §10).
    const evidence = await collectGroupEvidence(run.group_id as string, group.summary, run.bot_id);
    target = {
      category: group.category,
      summary: group.title,
      message_body: evidence.body,
      context: evidence.context || undefined,
      contextItems: evidence.contextItems,
    };
  } else {
    const message = one<{ body?: string; context?: unknown }>(insight!.messages);
    const primary = message?.body || insight!.summary;
    // 위젯 즉답이 꼬리질문 답을 이 인사이트에 갱신(source_message_ids)으로 흡수했을 수
    // 있다 — 엔진이 첫 턴만 보면 "쿠폰함 확인 안 돼요" 뿐이라 보충 내용을 놓친다.
    const supplements = await loadSupplementBodies(insight!.source_message_ids, run.bot_id);
    target = {
      category: insight!.category,
      summary: insight!.summary,
      message_body: appendSupplements(primary, supplements),
      // 위젯이 걷어온 페이지·브라우저·콘솔 에러. 카카오 등 다른 채널은 비어 있다.
      context: formatContextForPrompt(message?.context) || undefined,
      contextItems: collectContextItems([message?.context]),
    };
  }
  const identity: ValidationTarget = run.group_id ? {kind:'group',id:run.group_id} : {kind:'insight',id:run.insight_id!};
  return {insight:target, target:identity, evidenceDigest:digest(target)};
}

/**
 * 이미 실행권을 얻은 run 을 끝까지 돌린다. 결과(completed/failed)는 여기서 DB 에 남긴다.
 * 실패하면 저장한 뒤 다시 throw 한다 — 호출처가 화면(SSE)이든 크론이든 자기 방식으로 알린다.
 */
export async function executeClaimedRun(
  run: LoadedRun,
  leaseToken: string,
  onProgress: (message: string) => void = () => {},
  deadline = Date.now() + 240_000,
): Promise<RunResult> {
  const startTime = Date.now();
  let publicationPending = run.publication_status === 'pending';
  const assertExecutionLease = async () => {
    if (Date.now() >= deadline) throw new Error('deadline_exceeded');
    const {data,error} = await db().rpc('assert_pipeline_run_lease',{p_id:run.id,p_token:leaseToken});
    if(error || data !== true) throw new Error('execution_lease_lost');
  };
  await assertExecutionLease();
  const persist=(values:Record<string,unknown>)=>saveRun(run.id,values,leaseToken);
  const bot = one<{ github_repo_url: string | null; user_id: string }>(run.bots);

  // 묶음 실행이면 묶음이 대상이고, 아니면 예전처럼 인사이트 1건이 대상이다.
  const group = one<{ title: string; summary: string; category: string; status?: string; follow_up_pending?: boolean }>(run.insight_groups);
  const insight = one<{
    category: string;
    summary: string;
    source_message_ids?: string[] | null;
    group_id?: string | null;
    messages?: { body?: string; context?: unknown };
  }>(run.insights);

  if ((!group && !insight) || !bot?.github_repo_url) {
    await persist({ status: 'failed', error_message: 'Missing target or repo URL' });
    throw new AutoDevError('missing_target', 'Missing target or repository URL');
  }

  try {
    if (group && (group.follow_up_pending || group.status === 'merged')) {
      await persist({status:'stopped',stop_reason:'group_follow_up_hold'});
      throw new Error('group_follow_up_hold');
    }
    if(!run.group_id && insight?.group_id) { await persist({status:'stopped',stop_reason:'target_group_changed'});throw new Error('target_group_changed'); }
    const validationInput = await resolveRunValidationInput(run);
    const target = validationInput.insight;

    if (group) {
      onProgress(`Creating a fix for group "${group.title}"`);
    }

    const repository = new URL(bot.github_repo_url).pathname.replace(/^\/|\/$/g,'').replace(/\.git$/,'');
    // 한때 검증을 «통과»한 증거는 덮어쓰지 않는다. 지우면 다음 클레임 때
    // 「검증됐던 run 인가」를 가리는 가드가 안 걸려 조용히 강등된 채 검증 없이 발행된다.
    // `publicationPending` 과 같은 계열의 보호다(둘 다 「이미 있는 증명을 잃지 않는다」).
    const priorProof = run.validation_evidence as ValidationEvidence | undefined;
    const keepProof = priorProof?.status === 'validated';
    const resolution=await loadTrustedValidationConfig(repository,validationInput.target,validationInput.evidenceDigest);
    if (resolution.kind === 'blocked') {
      // 이 제보를 겨냥한 프로필이 «있는데» 적용할 수 없다(중복·증거 드리프트·불완전).
      // 사람이 검증을 요구해 둔 대상이므로 종전 그대로 중단한다.
      console.warn('[auto-dev] 검증 프로필을 적용할 수 없음', {runId:run.id,reason:resolution.reason});
      await persist({status:'stopped',stop_reason:'insufficient_evidence',...(publicationPending ? {} : {validation_status:'unverifiable'})});
      throw new Error('insufficient_evidence');
    }
    const validation = resolution.kind === 'profile' ? {profile:resolution.profile,runner:resolution.runner} : undefined;
    if (resolution.kind === 'none') {
      // 프로필이 없으면 검증 없이 진행한다 — 프로필은 제보마다 손으로 쓰는 것이고
      // 생성하는 코드가 없어서, 여기서 막으면 자동 PR 이 영영 꺼진 채로 남는다.
      // 다만 숨기지 않는다: 결과가 무엇이든 이 run 은 「검증 안 됨」으로 남는다.
      console.warn('[auto-dev] 이 제보를 겨냥한 검증 프로필이 없어 검증 없이 진행',
        {runId:run.id,repository,profilesForRepository:resolution.profilesForRepository});
      if (keepProof) {
        // 한때 검증을 통과한 run 인데 겨냥한 프로필이 그 뒤 사라졌다.
        // 엔진이 이 증거를 보고 중단한다(`validated_evidence_present`).
        console.warn('[auto-dev] 검증을 통과했던 run 인데 겨냥한 프로필이 사라졌다 — 증거를 남기고 중단',
          {runId:run.id,repository});
      } else if (!publicationPending) {
        // 검증에 «떨어진» 잔여 증거만 비운다. 남겨두면 DB 의 약한 가지가
        // `validation_evidence IS NOT NULL` 로 거절해 고아 PR + 영구 루프가 된다.
        // 이력은 `auto_dev_attempts` 에 그대로 남으므로 잃는 것이 없다.
        await persist({validation_status:'unverifiable',validation_evidence:null});
      }
    }
    await assertExecutionLease();
    const result = await callAutoDev({
      assertExecutionLease,
      validation,
      budget: run.generation_budget ? {...run.generation_budget as GenerationBudget,deadline} : undefined,
      onBudgetReserved: async ({model,calls,inputTokens,outputTokens,reservedUsd}) => persist({generation_budget:{model,calls,inputTokens,outputTokens,reservedUsd,deadline}}),
      publicationIntent: run.publication_intent as PublicationIntent | undefined,
      previousValidation: run.validation_evidence as ValidationEvidence | undefined,
      runId: run.id,
      deadline,
      onAttempt: async (evidence) => {
        const {error}=await db().rpc('record_pipeline_attempt',{p_id:run.id,p_token:leaseToken,p_evidence:evidence});
        if(error) throw new Error(`validation persistence: ${error.message}`);
      },
      onValidated: async (evidence) => persist({validation_status:evidence.status,validation_evidence:evidence}),
      onPublicationIntent: async (intent) => {
        await persist({publication_status:'pending',publication_intent:intent});
        publicationPending = true;
      },
      repoUrl: bot.github_repo_url,
      // 봇에 GitHub 토큰이 있으면 그걸로 간다 (B5)
      botId: run.bot_id,
      insight: target,
      onProgress,
    });

    if (result.status !== 'published') {
      await persist({status:result.status,stop_reason:result.reason,...(publicationPending || (keepProof && !result.validation) ? {} : {validation_status:result.validation?.status ?? 'unverifiable',validation_evidence:result.validation ?? null}),duration_ms:Date.now()-startTime});
      throw new Error(result.reason);
    }

    const {data:completed,error:completeError}=await db().rpc('complete_pipeline_run',{p_id:run.id,p_token:leaseToken,p_result:{pr_url:result.pr_url,pr_number:result.pr_number,files_changed:result.files_changed,explanation:result.explanation},p_duration:Date.now()-startTime});
    if(completeError || completed!==true) throw new Error(`publication persistence: ${completeError?.message ?? 'not completed'}`);

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[auto-dev] pipeline failed', { runId: run.id, message });
    // A typed terminal result or replacement owner must never be overwritten.
    await persist({status:'failed',error_message:message,duration_ms:Date.now()-startTime}).catch(() => {});
    throw err;
  }
}

async function saveRun(id: string, values: Record<string,unknown>, leaseToken:string): Promise<void> {
 const {data,error}=await db().rpc('save_pipeline_run',{p_id:id,p_token:leaseToken,p_values:values});
 if(error) throw new Error(`run persistence: ${error.message}`);
 if(data !== true) throw new Error('execution_lease_lost');
}
