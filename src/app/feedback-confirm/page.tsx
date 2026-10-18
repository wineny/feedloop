'use client';

import { useEffect, useState } from 'react';

type Receipt = { confirmation: 'fixed' | 'not_fixed' | null; confirmedAt: string | null };
type Target = { botId: string; visitorId: string; responseId: string };

export default function FeedbackConfirmPage() {
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
      .catch(() => setError('확인 내용을 불러오지 못했습니다. 위젯의 링크를 다시 열어 주세요.'))
      .finally(() => setBusy(false));
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
    } catch { setError('저장하지 못했습니다. 다시 시도해 주세요.'); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto max-w-lg p-8 space-y-5">
    <h1 className="text-2xl font-semibold">문제가 해결되었나요?</h1>
    <p>말씀하신 문제를 고쳤어요. 실제로 써 보신 결과를 알려 주세요. 서비스에 반영되기까지는 조금 걸릴 수 있어요.</p>
    {receipt?.confirmation && <p role="status">{receipt.confirmation === 'fixed' ? '해결되었다는 응답을 저장했습니다.' : '아직 해결되지 않았다는 응답을 저장했습니다. 담당자가 후속 확인합니다.'} {receipt.confirmedAt && <time dateTime={receipt.confirmedAt}>{new Date(receipt.confirmedAt).toLocaleString('ko-KR')}</time>}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="flex gap-3">
      <button className="rounded border px-4 py-2 disabled:opacity-50" disabled={busy || !receipt} onClick={() => confirm('fixed')}>해결됐어요</button>
      <button className="rounded border px-4 py-2 disabled:opacity-50" disabled={busy || !receipt} onClick={() => confirm('not_fixed')}>아직 해결되지 않았어요</button>
    </div>
    {busy && <p role="status">확인 중…</p>}
    <p className="text-sm">응답은 다시 선택해 변경할 수 있습니다.</p>
  </main>;
}
