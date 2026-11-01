import type { ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { DashboardPayments } from '@/app/api/dashboard/route';
import { APPROVALS_HREF, autoRefundAmount, paymentsLayout } from '@/lib/dashboard/payments';
import { RefundReasons } from '@/components/dashboard/RefundReasons';

// 대시보드 PayPal 줄 — 숫자 3칸(결제 문의·자동 환불·승인 대기) 또는 「PayPal 연결하기」 카드.
// 무엇을 그릴지는 `paymentsLayout`(lib/dashboard/payments.ts)이 고른다.
// 숫자 칸은 `LoopQuality` 와 같은 체계다 — 카드 하나를 헤어라인으로 가른 셀 + 24/800 tabular 숫자.
// 모바일은 세로로 쌓는다(라벨이 두 줄로 접히지 않게).

interface PaymentStatsProps {
  payments?: DashboardPayments | null;
  /**
   * 대시보드의 두 자리. `numbers` = 맨 첫 줄(연결됐을 때 숫자 3칸 + 필요하면 작은 연결 안내),
   * `connect` = 체크리스트 아래(연결 안 됐을 때 「PayPal 연결하기」 카드). 자기 자리가 아니면 아무것도 안 그린다.
   */
  placement: 'numbers' | 'connect';
  /** The payment ledger (`PaymentLedger`), drawn right under the numbers — only where the numbers are. */
  ledger?: ReactNode;
  /** The onboarding checklist is showing — its last step already says "Connect PayPal", so the standalone card stays hidden. */
  checklistVisible?: boolean;
}

interface CellProps {
  label: string;
  /** null = 집계 못 함. 0 과 다르다 — 0 으로 그리면 깨진 집계가 조용한 사실처럼 보인다 */
  value: number | null;
  /** 숫자 오른쪽에 붙는 보조 값(자동 환불 금액) */
  extra?: string | null;
  /** 빈 문자열이면 칸 높이(`min-h`)만 남긴다 */
  note: string;
  index: number;
  href?: string;
}

function Cell({ label, value, extra, note, index, href }: CellProps) {
  const t = useTranslations('dashboard.payments');
  const className = cn(
    'flex min-w-0 flex-col gap-1.5 p-5 sm:p-6',
    index > 0 && 'border-t border-border sm:border-l sm:border-t-0',
    href && 'transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none',
  );
  const body = (
    <>
      <span className="text-[12.5px] font-medium text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {value === null ? (
          <p className="text-2xl font-extrabold leading-tight text-muted-foreground" title={t('notCounted')}>
            <span aria-hidden>—</span>
            <span className="sr-only">{t('notCounted')}</span>
          </p>
        ) : (
          <p className="text-2xl font-extrabold leading-tight tracking-[-0.025em] tabular-nums">{value}</p>
        )}
        {extra && <p className="text-sm font-semibold text-muted-foreground tabular-nums">{extra}</p>}
      </div>
      <span
        className={cn(
          'min-h-[18px] text-[12.5px] leading-[1.45]',
          href ? 'inline-flex items-center gap-0.5 font-semibold text-brand-strong' : 'text-faint',
        )}
      >
        {note}
        {href && <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
      </span>
    </>
  );
  return href ? (
    <Link href={href} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

export function PaymentStats({ payments, placement, ledger, checklistVisible }: PaymentStatsProps) {
  const t = useTranslations('dashboard.payments');
  const layout = paymentsLayout(payments, { checklistVisible });
  if (layout.kind === 'none' || layout.kind !== placement || !payments) return null;

  if (layout.kind === 'connect') {
    return (
      <section aria-labelledby="paypal-connect-title" className="card-surface flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div className="min-w-0">
          <h2 id="paypal-connect-title" className="text-base font-bold tracking-[-0.01em]">
            {t('connect.title')}
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{t('connect.body')}</p>
        </div>
        <Button asChild className="self-start sm:self-auto">
          <Link href={layout.connectHref}>{t('connect.cta')}</Link>
        </Button>
      </section>
    );
  }

  const pending = payments.pendingApprovals;
  const refunds = payments.autoRefunds7d;

  return (
    <section aria-labelledby="paypal-stats-title" className="flex flex-col gap-3">
      <h2 id="paypal-stats-title" className="text-sm font-bold">
        {t('title')}
      </h2>
      <div className="card-surface grid grid-cols-1 overflow-hidden sm:grid-cols-3">
        <Cell index={0} label={t('inquiries')} value={payments.inquiries7d} note={t('last7d')} />
        <Cell index={1} label={t('autoRefunds')} value={refunds?.count ?? null} extra={autoRefundAmount(refunds)} note={t('last7d')} />
        <Cell
          index={2}
          label={t('pending')}
          value={pending}
          // null(집계 못 함)이면 「기다리는 요청 없음」이라고 말하지 않는다 — 모르는 것을 0 처럼 말하게 된다
          note={pending === null ? '' : pending > 0 ? t('pendingCta') : t('pendingNone')}
          href={pending !== null && pending > 0 ? APPROVALS_HREF : undefined}
        />
      </div>

      {/* 환불 사유 — 숫자 바로 아래, 장부 위. 필드가 없는 응답(예전 모양)이면 그리지 않는다. */}
      {payments.refundReasons !== undefined && <RefundReasons data={payments.refundReasons} />}

      {/* 장부(환불 + 구매 주문, 최신순) — 숫자 바로 아래. */}
      {ledger}

      {/* 보고 있는 봇 중 하나는 연결됐지만 내 봇 하나가 아직이다. 숫자가 주인공이라 연결 안내는 한 줄로 작게 둔다. */}
      {layout.connectHref && (
        <div className="card-surface flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-5 py-3.5">
          <p className="min-w-0 text-[12.5px] text-muted-foreground">{t('connect.more')}</p>
          <Link href={layout.connectHref} className="inline-flex items-center gap-0.5 text-[12.5px] font-semibold text-brand-strong hover:underline">
            {t('connect.cta')}
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>
      )}
    </section>
  );
}
