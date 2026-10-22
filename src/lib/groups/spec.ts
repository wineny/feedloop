// 기능 요청 묶음 → 스펙 초안 (Gleap 차용 P1-3, Kai PM 에 대응).
//
// 기능 요청에 코드 수정 PR 을 여는 것은 대개 틀린 답이다. 무엇을 만들지는 사람이 정해야 하고,
// AI 가 먼저 코드를 써버리면 그 판단을 건너뛴 채 리뷰가 시작된다.
// 대신 "여러 사람이 말한 요청" 을 읽을 수 있는 형태로 정리해 두고, 만들지 말지는 운영자가 정한다.
//
// 레포를 읽지 않는다 — 그래서 자동 PR(85~128초)과 달리 빠르고 싸다.

import { getServiceRoleClient } from '@/lib/supabase';
import { callClaude } from '@/lib/auto-dev/ai-engine';
import { appendSupplements, loadSupplementBodies } from '@/lib/insights/supplements';
import { OWNER_CONTENT_LANGUAGE } from '@/i18n/owner-locale';

const EVIDENCE_LIMIT = 8;
const EVIDENCE_CHARS = 300;

function db() {
  return getServiceRoleClient();
}

export function buildSpecPrompt(
  group: { title: string; summary: string },
  voices: string[],
): string {
  return `You are a product manager. Below is what users of one service said when they asked for **the same thing**.
Turn it into a **draft spec** the team can read to decide "build it or not".

## Group
- Title: ${group.title}
- Summary: ${group.summary}

## What users actually said (${voices.length})
${voices.map((v) => `- "${v}"`).join('\n')}

## Output format
Write markdown only, not JSON. Write it in ${OWNER_CONTENT_LANGUAGE}, even when the users wrote in another language.
Use the subheadings below exactly as written.

### What users want
(The core of the request in 2–3 lines. Do not invent anything the users did not say.)

### Why it is needed
(The reasons and pain points users gave. Quote the words that support them.)

### What it could look like
(3–5 concrete behaviors as bullets. If there is a screen, what appears where.)

### Open decisions
(2–4 forks a person has to decide. For example: scope, defaults, relation to existing features)

### Reasons not to build it
(The case against, honestly. If the request is a minority view or a workaround already exists, say so.)

## Rules
- **Do not invent requirements the users did not state.** If you need to guess, leave it as a question under "Open decisions".
- Do not write code or file paths. This is material for a decision, not implementation instructions.
- Keep the whole draft to about 150–350 words.`;
}

export interface SpecResult {
  spec: string;
  evidenceCount: number;
}

/** 묶음 하나의 스펙 초안을 만들어 저장한다. */
export async function generateGroupSpec(groupId: string): Promise<SpecResult> {
  const { data: group } = await db()
    .from('insight_groups')
    .select('id, bot_id, title, summary')
    .eq('id', groupId)
    .maybeSingle();

  if (!group) throw new Error('Group not found');

  const { data: insights } = await db()
    .from('insights')
    .select('summary, source_message_ids, messages(body)')
    .eq('group_id', groupId)
    .limit(EVIDENCE_LIMIT);

  // I-05 — 위젯 즉답이 꼬리질문 답을 기존 인사이트에 흡수(source_message_ids)하므로,
  // 첫 턴만 읽으면 「쿠폰함 확인 안 돼요」 뿐이고 무엇을 만들지 판단할 재료가 빠진다.
  // 자동 PR 경로와 **같은 모듈**을 쓴다 — 같은 묶음이 경로에 따라 다르게 읽히면 안 된다.
  const voices = (
    await Promise.all(
      (insights ?? []).map(async (i) => {
        const msg = i.messages as { body?: string } | { body?: string }[] | null;
        const one = Array.isArray(msg) ? msg[0] : msg;
        const primary = one?.body ?? (i.summary as string | null);
        if (typeof primary !== 'string' || primary.trim() === '') return null;
        const truncated =
          primary.length > EVIDENCE_CHARS ? `${primary.slice(0, EVIDENCE_CHARS)}…` : primary;
        const supplements = await loadSupplementBodies(
          i.source_message_ids as string[] | null,
          group.bot_id as string,
        );
        return appendSupplements(truncated, supplements);
      }),
    )
  ).filter((v): v is string => v !== null);

  if (voices.length === 0) throw new Error('This group has no feedback text to summarize');

  const spec = (
    await callClaude(
      buildSpecPrompt(
        { title: group.title as string, summary: (group.summary as string) ?? '' },
        voices,
      ),
      2048,
      'Writing spec draft',
    )
  ).trim();

  const { error } = await db()
    .from('insight_groups')
    .update({ spec_draft: spec, spec_drafted_at: new Date().toISOString() })
    .eq('id', groupId);

  if (error) throw new Error(`Could not save the spec: ${error.message}`);

  return { spec, evidenceCount: voices.length };
}
