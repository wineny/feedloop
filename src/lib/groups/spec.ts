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

const EVIDENCE_LIMIT = 8;
const EVIDENCE_CHARS = 300;

function db() {
  return getServiceRoleClient();
}

export function buildSpecPrompt(
  group: { title: string; summary: string },
  voices: string[],
): string {
  return `당신은 제품 매니저입니다. 아래는 한 서비스의 사용자들이 **같은 요청**을 말한 것들입니다.
이것을 팀이 읽고 "만들지 말지" 를 판단할 수 있는 **스펙 초안**으로 정리하세요.

## 묶음
- 제목: ${group.title}
- 요약: ${group.summary}

## 사용자들이 실제로 한 말 (${voices.length}건)
${voices.map((v) => `- "${v}"`).join('\n')}

## 출력 형식
마크다운으로만 쓰세요. JSON 아닙니다. 아래 소제목을 그대로 쓰세요.

### 사용자가 원하는 것
(요청의 핵심을 2~3줄. 사용자의 말에 없는 내용을 지어내지 마세요.)

### 왜 필요한가
(사용자들이 밝힌 이유·불편. 근거가 되는 표현을 인용하세요.)

### 만든다면 이런 모습
(구체적인 동작 3~5개를 불릿으로. 화면이 있다면 어디에 무엇이 생기는지.)

### 정해야 할 것
(사람이 결정해야 하는 갈림길 2~4개. 예: 범위·기본값·기존 기능과의 관계)

### 안 만들어도 되는 이유
(반대편 근거를 솔직하게. 요청이 소수 의견이거나 우회로가 이미 있다면 그렇게 쓰세요.)

## 규칙
- **사용자가 말하지 않은 요구를 지어내지 마세요.** 추측이 필요하면 "정해야 할 것" 에 질문으로 남기세요.
- 코드나 파일 경로를 쓰지 마세요. 이건 구현 지시가 아니라 판단 재료입니다.
- 분량은 전체 400자~900자.`;
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

  if (!group) throw new Error('묶음을 찾을 수 없습니다');

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

  if (voices.length === 0) throw new Error('이 묶음에는 정리할 피드백 원문이 없습니다');

  const spec = (
    await callClaude(
      buildSpecPrompt(
        { title: group.title as string, summary: (group.summary as string) ?? '' },
        voices,
      ),
      2048,
      '스펙 초안 작성 중',
    )
  ).trim();

  const { error } = await db()
    .from('insight_groups')
    .update({ spec_draft: spec, spec_drafted_at: new Date().toISOString() })
    .eq('id', groupId);

  if (error) throw new Error(`스펙을 저장하지 못했습니다: ${error.message}`);

  return { spec, evidenceCount: voices.length };
}
