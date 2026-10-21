'use client';

// One button that turns a fresh Google login into an approver of the demo bot and lands them in its inbox.
// The first thing a hackathon judge touches after signing in, so the English text is the one that gets the care.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useBotScope } from '@/lib/scope/BotScopeProvider';

export function TryDemoBotButton({ variant = 'outline' }: { variant?: 'outline' | 'default' }) {
  const t = useTranslations('bots.list.tryDemo');
  const router = useRouter();
  const scope = useBotScope();
  const [state, setState] = useState<'idle' | 'joining' | 'error'>('idle');

  async function join() {
    setState('joining');
    try {
      const res = await fetch('/api/demo/join', { method: 'POST' });
      if (!res.ok) throw new Error(String(res.status));
      const { botId } = (await res.json()) as { botId: string };
      // The inbox reads its bot from the header scope (localStorage), not from the URL, so set the
      // scope here; the scope list must be reloaded first or the new id resolves to "all bots".
      await scope.refresh();
      scope.setBotId(botId);
      // Server pages read the membership on their next render; refresh so /bots lists the new bot too.
      router.refresh();
      router.push('/inbox');
    } catch {
      setState('error');
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button variant={variant} onClick={join} disabled={state === 'joining'}>
        {state === 'joining' ? t('joining') : t('button')}
      </Button>
      {state === 'error' && (
        <span className="text-xs text-destructive">{t('error')}</span>
      )}
    </div>
  );
}
