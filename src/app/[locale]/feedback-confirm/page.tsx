'use client';

import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

type Receipt = { confirmation: 'fixed' | 'not_fixed' | null; confirmedAt: string | null };
type Target = { botId: string; visitorId: string; responseId: string };

export default function FeedbackConfirmPage() {
  const t = useTranslations('feedbackConfirm');
  const format = useFormatter();
  const [target, setTarget] = useState<Target | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    // Fragment credentials stay out of server access logs and outgoing referrers.
    const args = new URLSearchParams(window.location.hash.slice(1));
    const next = { botId: args.get('botId') ?? '', visitorId: args.get('visitorId') ?? '', responseId: args.get('responseId') ?? '' };
    setTarget(next);
    const query = new URLSearchParams({ visitorId: next.visitorId, responseId: next.responseId });
    fetch(`/api/widget/${encodeURIComponent(next.botId)}/confirm?${query}`, { cache: 'no-store', referrerPolicy: 'no-referrer' })
      .then(async (res) => { const data = await res.json(); if (!res.ok) throw new Error(data.error); setReceipt(data); })
      .catch(() => setError(t('loadError')))
      .finally(() => setBusy(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 주소의 해시를 한 번만 읽는다. 언어가 바뀌어도 다시 부르지 않는다
  }, []);
  async function confirm(confirmation: 'fixed' | 'not_fixed') {
    if (!target) return;
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/widget/${encodeURIComponent(target.botId)}/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, referrerPolicy: 'no-referrer',
        body: JSON.stringify({ visitorId: target.visitorId, responseId: target.responseId, confirmation }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setReceipt(data);
    } catch { setError(t('saveError')); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto max-w-lg p-8 space-y-5">
    <h1 className="text-2xl font-semibold">{t('title')}</h1>
    <p>{t('intro')}</p>
    {receipt?.confirmation && <p role="status">{receipt.confirmation === 'fixed' ? t('savedFixed') : t('savedNotFixed')} {receipt.confirmedAt && <time dateTime={receipt.confirmedAt}>{format.dateTime(new Date(receipt.confirmedAt), { dateStyle: 'medium', timeStyle: 'short' })}</time>}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="flex gap-3">
      <button className="rounded border px-4 py-2 disabled:opacity-50" disabled={busy || !receipt} onClick={() => confirm('fixed')}>{t('fixed')}</button>
      <button className="rounded border px-4 py-2 disabled:opacity-50" disabled={busy || !receipt} onClick={() => confirm('not_fixed')}>{t('notFixed')}</button>
    </div>
    {busy && <p role="status">{t('checking')}</p>}
    <p className="text-sm">{t('changeNote')}</p>
  </main>;
}
