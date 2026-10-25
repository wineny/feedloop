// Bot settings › PayPal — the bot's own sandbox keys, webhook, refund limits and switches (design §3).
//
// Owner only, like the other settings pages: someone else's bot looks the same as a missing one.
// The first state is read here with the same function the GET route answers with
// (`presentPayPalSettings` — no secret, not even ciphertext), so the screen does not open on a spinner.
// Every change goes through `api/bots/[id]/paypal` from the client panel.

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { notFound, redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getServiceRoleClient } from '@/lib/supabase';
import { PageHero } from '@/components/layout/PageHero';
import { PayPalSettingsPanel } from '@/components/bots/PayPalSettingsPanel';
import { loadPayPalSettings, presentPayPalSettings } from '@/lib/paypal/settings';

export const dynamic = 'force-dynamic';

export default async function BotPayPalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getTranslations('bots.pages.paypal');

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=/bots/${id}/paypal`);
  }

  const { data: bot } = await getServiceRoleClient()
    .from('bots')
    .select('id, user_id, service_name')
    .eq('id', id)
    .single();

  // Someone else's bot is treated like a missing one — its existence is not revealed.
  if (!bot || bot.user_id !== session.user.id) {
    notFound();
  }

  const row = await loadPayPalSettings(bot.id);
  if (!row) notFound();

  return (
    <div className="flex flex-col gap-6">
      <PageHero
        title={t('title')}
        description={t('description', { name: bot.service_name })}
        actions={
          <Link
            href="/bots"
            className="text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {t('back')}
          </Link>
        }
      />

      <PayPalSettingsPanel botId={bot.id} initial={presentPayPalSettings(row)} />
    </div>
  );
}
