'use client';

// 봇 설정 › API 키 — **루프의 어느 칸이 어느 두뇌로 도는가**.
//
// 앞선 판은 키 입력 칸 하나만 덩그러니 있었다. 그래서 운영자가 넣은 키가 답변에만
// 쓰이는 줄 알았는데, 실제로는 분류·묶기·요약도 같은 키로 돌고 수정안은 우리 키로
// 돌았다. 화면이 그 사실을 한 번도 말하지 않은 것이 문제였다(2026-09-20 ny 지적).
//
// 그래서 칸을 «루프 단계»로 세운다. 카드 세 장을 나란히 쌓지 않는 이유가 있다 —
// 이 셋은 나란한 선택지가 아니라 **앞뒤가 있는 한 줄기**다. 들어온 피드백이 정리되고,
// 정리된 것이 수정안이 된다. 세로선이 그 순서를 말하고, 대시보드(`LoopStages`)에서
// 이미 본 이모지가 「저기 그 칸」임을 말한다.
//
// 🔴 잠긴 칸에 **입력을 허용하지 않는다.** 넣게 해 놓고 저장만 안 하면 두 가지가 나빠진다 —
//    ① 운영자가 진짜 API 키를 붙여넣은 뒤에야 저장이 안 되는 걸 안다(키를 헛되이 노출한다)
//    ② 화면이 「이 키로 분류합니다」라고 거짓말을 한다. 지금 뒷단은 봇당 키 하나만 읽는다.

import Image from 'next/image';
import { Lock } from 'lucide-react';
import { LlmKeyForm } from '@/components/onboarding/LlmKeyForm';
import { LLM_PURPOSES, LOOP_CLOSING_STAGE, type LlmPurposeSpec } from '@/lib/llm/purposes';
import { LLM_PROVIDERS, PROVIDER_LABELS } from '@/lib/llm/models';
import { cn } from '@/lib/utils';

export function LlmPurposePanel({ botId, serviceName }: { botId: string; serviceName: string }) {
  return (
    <div className="flex max-w-[680px] flex-col gap-7">
      {/* 키 유무와 «무관하게» 참인 문장만 쓴다. 자기 키를 넣은 봇은 답변만큼은 자기 돈으로
          돌고 있으므로 「전부 피드루프가 냅니다」는 그 운영자에게 거짓말이 된다. */}
      <p className="text-sm leading-relaxed text-muted-foreground">
        {serviceName} 봇은 루프의 칸마다 다른 일을 합니다. 지금은 베타 기간이라{' '}
        <b className="font-semibold text-foreground">피드백 정리와 수정안 만들기는 피드루프가 부담해요.</b>{' '}
        키를 넣지 않아도 네 칸이 모두 돕니다.
      </p>

      <ol className="flex flex-col">
        {LLM_PURPOSES.map((spec) => (
          <Stage key={spec.key} emoji={spec.emoji} stage={spec.stage}>
            <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <h2 className="text-base font-semibold leading-none">{spec.title}</h2>
              {spec.open ? (
                <span className="rounded-full bg-brand-subtle px-2 py-0.5 text-[11px] font-semibold text-brand-strong">
                  내 키로 돌릴 수 있어요
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                  <Lock className="h-3 w-3" aria-hidden />
                  베타 기간에는 피드루프가 부담
                </span>
              )}
            </header>

            <p className="text-[13px] leading-relaxed text-muted-foreground">{spec.what}</p>

            {spec.open ? (
              <LlmKeyForm botId={botId} serviceName={serviceName} />
            ) : (
              <LockedFields spec={spec} />
            )}

            <p className="border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground">
              {spec.guide}
            </p>
          </Stage>
        ))}

        {/* 마지막 칸은 설정이 없다. 그래도 그리는 이유 — 여기서 끊으면 루프가 아니라
            「3단계 퍼널」로 읽힌다. 되돌려주는 칸이 이 제품의 이름이고 주장이다. */}
        <Stage emoji={LOOP_CLOSING_STAGE.emoji} stage={LOOP_CLOSING_STAGE.stage} isLast>
          <h2 className="text-base font-semibold leading-none">{LOOP_CLOSING_STAGE.stage}</h2>
          <p className="text-[13px] leading-relaxed text-muted-foreground">{LOOP_CLOSING_STAGE.what}</p>
        </Stage>
      </ol>
    </div>
  );
}

/**
 * 루프 한 칸. 이모지 아래로 내려가는 세로선이 «순서»를 말한다 — 마지막 칸만 선이 없다.
 *
 * 이모지에 `alt` 를 준다(대시보드처럼 `aria-hidden` 으로 비우지 않는다). 여기서는 이모지가
 * 장식이 아니라 「대시보드에서 본 그 칸」이라는 유일한 표시라, 화면을 못 보는 사람에게도
 * 단계 이름이 가야 한다.
 */
function Stage({
  emoji,
  stage,
  isLast = false,
  children,
}: {
  emoji: string;
  stage: string;
  isLast?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className={cn('relative flex gap-3.5', isLast ? 'pb-0' : 'pb-8')}>
      {!isLast && (
        <span
          aria-hidden
          className="absolute bottom-0 left-3 top-8 w-px bg-border"
        />
      )}
      <Image src={emoji} alt={stage} width={24} height={24} className="h-6 w-6 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 pt-0.5">{children}</div>
    </li>
  );
}

/**
 * 잠긴 칸의 입력 미리보기. **전부 비활성이고, 폼이 아니다.**
 *
 * 모양만 보여주는 이유: 운영자가 「베타가 끝나면 여기에 내 키를 넣게 되는구나」를 알아야
 * 한다. 그렇다고 진짜 입력을 열면 위 주석의 두 가지가 그대로 벌어진다.
 */
function LockedFields({ spec }: { spec: LlmPurposeSpec }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-dashed border-border-strong/70 bg-muted/40 p-3"
      aria-label={`${spec.title} — 베타 기간에는 설정할 수 없습니다`}
    >
      <div className="inline-flex w-fit flex-wrap rounded-full border border-border-strong/60 p-0.5 opacity-55">
        {LLM_PROVIDERS.map((p) => (
          <span key={p} className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
            {PROVIDER_LABELS[p]}
          </span>
        ))}
      </div>

      {/* 두 칸을 한 줄로 나란히 둔다. 세로로 쌓으면 잠긴 칸 둘이 화면 무게를 다 가져가는데,
          이 화면의 주인공은 «지금 설정할 수 있는» 첫 칸이다(2026-09-20 화면 확인). */}
      <div className="flex flex-wrap gap-2">
        <div className="flex h-9 flex-1 basis-40 items-center rounded-[10px] border border-border-strong/60 bg-background/60 px-2.5 text-[13px] text-faint">
          모델 — 베타 이후 선택
        </div>
        <div className="flex h-9 flex-1 basis-40 items-center rounded-[10px] border border-border-strong/60 bg-background/60 px-2.5 text-[13px] text-faint">
          API 키 — 지금은 필요 없어요
        </div>
      </div>
    </div>
  );
}
