'use client';

import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

/** 내부 페이지 공통 로딩 상태 — 코랄 점 3개 펄스 */
export function LoadingState({ label }: { label?: string }) {
  const t = useTranslations('common');
  label ??= t('loading');
  return (
    <div className="flex h-[60vh] flex-col items-center justify-center gap-4" role="status" aria-label={label}>
      <div className="flex items-center gap-1.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-2.5 w-2.5 animate-pulse rounded-full bg-primary"
            style={{ animationDelay: `${i * 0.18}s` }}
          />
        ))}
      </div>
      <span className="text-sm text-muted-foreground">{label}…</span>
    </div>
  );
}

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

/** 내부 페이지 공통 에러 상태 */
export function ErrorState({ message, onRetry }: ErrorStateProps) {
  const t = useTranslations('common');
  return (
    <div className="flex h-[60vh] items-center justify-center">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 px-8 py-10 text-center">
        <span className="text-[13px] font-semibold text-muted-foreground">{t('temporaryProblem')}</span>
        <p className="text-sm leading-relaxed text-muted-foreground">{message}</p>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            {t('retry')}
          </Button>
        )}
      </div>
    </div>
  );
}
