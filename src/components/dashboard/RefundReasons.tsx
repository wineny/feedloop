import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ExternalLink } from '@/components/demo/ExternalLink';
import type { RefundBucket, RefundReasonItem, RefundReasons as RefundReasonsData } from '@/lib/dashboard/refund-reasons';

// 환불 사유 카드 — PayPal 숫자 바로 아래. 환불 요청을 고객이 말한 이유로 네 갈래로 나누고(버그·UX → 수정 PR,
// 기능 요청 → 스펙, 나머지 → 여기서 보임), 많이 나온 이유 3개를 링크와 함께 보인다. 집계는 `lib/dashboard/refund-reasons.ts`.
// 0 인 갈래도 흐리게 남긴다 — 네 칸이 늘 보여야 「이유 → 어디로 가는지」가 읽힌다.

const BUCKETS: RefundBucket[] = ['fix', 'feature', 'other', 'unclassified'];

interface RefundReasonsProps {
  /** null = 집계 못 함(조회 실패·상한 도달). 0 과 다르다. */
  data: RefundReasonsData | null;
}

interface TopReasonProps {
  item: RefundReasonItem;
}

function TopReason({ item }: TopReasonProps) {
  const t = useTranslations('dashboard.payments.refundReasons');
  const linkClass = 'inline-flex shrink-0 items-center gap-0.5 text-[12.5px] font-semibold text-brand-strong hover:underline';
  return (
    <li className="flex min-w-0 flex-col gap-1 py-3 first:pt-0 last:pb-0">
      <p className="line-clamp-2 min-w-0 break-words text-sm font-medium leading-snug">{item.label ?? t('noReason')}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[12.5px] text-muted-foreground tabular-nums">
          {t('count', { count: item.count })} · {t(`buckets.${item.bucket}`)}
        </span>
        {item.spike && (
          <span
            className="inline-flex shrink-0 items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11.5px] font-semibold text-amber-800"
            title={t('spikeHint', { count: item.recent24h })}
          >
            {t('spike')}
          </span>
        )}
        {item.href &&
          (item.external ? (
            // 견본 PR(`github.com/example/...`)은 없는 주소라 누를 수 없는 글자로만 보인다(ExternalLink).
            <ExternalLink href={item.href} className={linkClass}>
              {t('openPr')}
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </ExternalLink>
          ) : (
            <Link href={item.href} className={linkClass}>
              {t('openConversation')}
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          ))}
      </div>
    </li>
  );
}

export function RefundReasons({ data }: RefundReasonsProps) {
  const t = useTranslations('dashboard.payments.refundReasons');
  const tPayments = useTranslations('dashboard.payments');
  const tStudio = useTranslations('dashboard.studio');

  return (
    <section aria-labelledby="refund-reasons-title" className="card-surface flex min-w-0 flex-col gap-4 p-5 sm:p-6">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <div className="min-w-0">
          <h3 id="refund-reasons-title" className="text-sm font-bold">
            {t('title')}
          </h3>
          <p className="text-[12.5px] leading-[1.45] text-muted-foreground">{t('subtitle')}</p>
        </div>
        {data && data.total > 0 && <span className="text-[12.5px] text-faint tabular-nums">{t('total', { count: data.total })}</span>}
      </div>

      {data === null ? (
        <p className="text-[12.5px] text-muted-foreground" title={tPayments('notCounted')}>
          <span aria-hidden>— </span>
          {tPayments('notCounted')}
        </p>
      ) : data.total === 0 ? (
        <p className="text-[12.5px] text-faint">{t('empty')}</p>
      ) : (
        <>
          <ul className="grid min-w-0 grid-cols-2 overflow-hidden rounded-lg border border-border sm:grid-cols-4">
            {BUCKETS.map((bucket, index) => {
              const count = data.buckets[bucket];
              return (
                <li
                  key={bucket}
                  className={cn(
                    'flex min-w-0 flex-col gap-0.5 p-3',
                    index % 2 === 1 && 'border-l border-border',
                    index >= 2 && 'border-t border-border sm:border-t-0',
                    index === 2 && 'sm:border-l',
                    count === 0 && 'text-faint',
                  )}
                >
                  <span className="text-lg font-extrabold leading-tight tracking-[-0.02em] tabular-nums">{count}</span>
                  <span className={cn('break-words text-[12.5px] font-medium', count === 0 ? 'text-faint' : 'text-muted-foreground')}>
                    {t(`buckets.${bucket}`)}
                  </span>
                  <span className="break-words text-[12px] leading-[1.4] text-faint">{t(`hints.${bucket}`)}</span>
                </li>
              );
            })}
          </ul>

          {data.top.length > 0 && (
            <div className="flex min-w-0 flex-col gap-2">
              <h4 className="text-[12.5px] font-medium text-muted-foreground">{t('topTitle')}</h4>
              <ol className="flex min-w-0 flex-col divide-y divide-border">
                {data.top.map((item) => (
                  <TopReason key={item.key} item={item} />
                ))}
              </ol>
            </div>
          )}
        </>
      )}

      {/* Refund Studio (AG Studio) works on its own sample store, so the link is there whatever this card shows.
          Plain next/link like the conversation links above (the card's tests can't load next-intl navigation). */}
      <Link
        href="/dashboard/refunds"
        className="inline-flex w-fit items-center gap-0.5 text-[12.5px] font-semibold text-brand-strong hover:underline"
      >
        {tStudio('open')}
        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
      </Link>
    </section>
  );
}
