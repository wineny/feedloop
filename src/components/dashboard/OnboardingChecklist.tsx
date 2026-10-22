import Image from 'next/image';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import type { OnboardingStep } from '@/lib/dashboard/onboarding';

// 첫 루프까지 4단계 — 제보가 0 인 계정에만 선다(숨김 규칙은 lib/dashboard/onboarding.ts).
// 숫자 네 칸이 전부 0 인 화면은 「뭘 잘못했나」로 읽힌다. 그 자리에서 다음 할 일을 말한다.
// v4: 카드 하나에 담고 머리에 로켓 이모지(self-host, public/emoji) 하나만 둔다 — 루프 4단계 이모지는
// `LoopStages` 의 것이라 여기서 다시 쓰지 않는다.

interface OnboardingChecklistProps {
  steps: OnboardingStep[];
}

export function OnboardingChecklist({ steps }: OnboardingChecklistProps) {
  const t = useTranslations('dashboard.onboarding');
  // 진행 수는 필수 단계만 센다(제목·「n/4」와 맞게). 선택 단계(PayPal)는 끝나도 숫자를 올리지 않는다
  const doneCount = steps.filter((step) => !step.optional && step.done).length;

  return (
    <section aria-labelledby="onboarding-title" className="card-surface p-5 sm:p-6">
      <div className="flex items-start gap-4">
        <Image src="/emoji/rocket_3d.png" alt="" width={44} height={44} className="h-11 w-11 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <h2 id="onboarding-title" className="text-xl font-bold tracking-[-0.02em]">
              {t('title')}
            </h2>
            <span className="text-[12.5px] leading-[1.45] text-faint tabular-nums">{t('progress', { done: doneCount })}</span>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{t('hide')}</p>
        </div>
      </div>

      <ol className="mt-4 divide-y divide-border">
        {steps.map((step) => (
          <li key={step.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-4">
            <span
              aria-hidden
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-[1.5px] text-[12.5px] font-bold tabular-nums',
                step.done
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border-strong text-muted-foreground',
              )}
            >
              {step.done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : step.order}
            </span>

            <span className={cn('min-w-0 flex-1 text-sm', step.done ? 'text-muted-foreground' : 'font-medium')}>
              {t(`steps.${step.key}.label`)}
            </span>

            {step.done ? (
              <span className="text-[12.5px] leading-[1.45] text-faint">{t('done')}</span>
            ) : (
              <Link href={step.href} className="text-sm font-semibold text-brand-strong hover:underline">
                {t(`steps.${step.key}.action`)} →
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
