'use client';

import { useRef, useState, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { AgStudioApi, AgStudioMode } from 'ag-studio';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { PageHero, PAGE_EMOJI } from '@/components/layout/PageHero';
import { Button } from '@/components/ui/button';

// AG Studio (with AG Grid/Charts Enterprise) loads only here, in the browser.
const RefundStudio = dynamic(() => import('./RefundStudio'), {
  ssr: false,
  loading: () => <StudioLoading />,
});

const LARGE_SCREEN = '(min-width: 64rem)'; // Tailwind `lg`

function subscribeLarge(onChange: () => void) {
  const mq = window.matchMedia(LARGE_SCREEN);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

/** false on the server and in the hydration render, so small screens never download Studio's bundle. */
function useLargeScreen(): boolean {
  return useSyncExternalStore(subscribeLarge, () => window.matchMedia(LARGE_SCREEN).matches, () => false);
}

function StudioLoading() {
  const t = useTranslations('dashboard.studio');
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {t('loading')}
    </div>
  );
}

interface RefundStudioPageProps {
  licenseKey?: string;
  aiEnabled: boolean;
}

export function RefundStudioPage({ licenseKey, aiEnabled }: RefundStudioPageProps) {
  const t = useTranslations('dashboard.studio');
  const [mode, setMode] = useState<AgStudioMode>('view');
  const apiRef = useRef<AgStudioApi | null>(null);
  const large = useLargeScreen();
  // Stays mounted once loaded: a brief narrow window must not throw away the chat and any edits.
  const [loaded, setLoaded] = useState(false);
  if (large && !loaded) setLoaded(true);

  const handleReset = async () => {
    const api = apiRef.current;
    if (!api) return;
    const { resetStudio } = await import('./RefundStudio');
    resetStudio(api);
  };

  return (
    <div className="flex flex-col gap-5">
      <Link href="/dashboard" className="inline-flex w-fit items-center gap-1 text-[13px] font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        {t('back')}
      </Link>
      <PageHero
        emoji={PAGE_EMOJI.dashboard}
        title={t('title')}
        description={
          <>
            <span className="mr-2 inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[11.5px] font-semibold text-foreground" title={t('sampleNote')}>
              {t('sampleBadge')}
            </span>
            {t('description')}
          </>
        }
        actions={
          <div className="hidden items-center gap-2 lg:flex">
            {mode === 'edit' && (
              <Button variant="ghost" onClick={handleReset}>
                {t('reset')}
              </Button>
            )}
            {/* AG Studio shows its AI panel in edit mode only, so asking the agent and editing are one mode here. */}
            <Button variant={mode === 'edit' ? 'outline' : 'default'} onClick={() => setMode(mode === 'edit' ? 'view' : 'edit')}>
              {mode === 'edit' ? t('done') : aiEnabled ? t('ask') : t('edit')}
            </Button>
          </div>
        }
      />
      {/* Studio is a desktop tool; below lg the page says so instead of squeezing a 24-column canvas. */}
      <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground lg:hidden">{t('smallScreen')}</p>
      <div className="hidden h-[calc(100dvh-14rem)] min-h-[720px] overflow-hidden rounded-xl border border-border lg:block">
        {loaded && <RefundStudio licenseKey={licenseKey} aiEnabled={aiEnabled} mode={mode} onApi={(api) => (apiRef.current = api)} />}
      </div>
    </div>
  );
}
