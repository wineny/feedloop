'use client';

// 웹 위젯 붙이기 — 한 단계짜리 갈래.
//
// 우리가 붙일 게 없다. 고객이 자기 서비스에 스크립트 한 줄을 넣으면 끝이고, 위젯이 처음 뜨는
// 순간 첫 폴링(GET /api/widget/[botId]/messages)이 widget_connected_at 을 찍는다.
//
// 예전 화면이 못 푼 문제는 「어디에 넣느냐」였다(I-02). 스니펫과 복사 버튼만 있고 프레임워크별
// 자리가 없어서, 코드를 만질 줄 모르는 운영자는 복사한 줄을 손에 쥔 채 멈췄다. 자리표를
// 스니펫 «바로 밑»에 둔다 — 복사한 다음 눈이 가는 곳이 거기다.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ConnectStep, ConnectSteps } from '@/components/onboarding/ConnectSteps';
import { ConnectedPanel, WaitingLine } from '@/components/onboarding/ConnectStatus';
import { useConnectionStatus } from '@/lib/hooks/useConnectionStatus';

interface WebWidgetConnectGuideProps {
  botId: string;
  /** 위젯 스크립트 주소. 예: https://ai-feedloop.vercel.app/widget.js */
  scriptSrc: string;
  /** 위젯 모양 설정 화면 경로 */
  appearanceHref: string;
  initiallyConnected: boolean;
}

/** 넣는 자리. 「대부분의 서비스가 이 넷 중 하나」라서 넷만 둔다 — 더 늘리면 자기 것을 못 찾는다 */
const PLACES = ['next', 'html', 'wordpress', 'webflow'] as const;

export function WebWidgetConnectGuide({
  botId,
  scriptSrc,
  appearanceHref,
  initiallyConnected,
}: WebWidgetConnectGuideProps) {
  const t = useTranslations('connect');
  const { connected, polling, resume } = useConnectionStatus(
    botId,
    (data) => data.widget_connected,
    initiallyConnected,
  );
  const [copied, setCopied] = useState(false);

  // 화면에 보여주는 것과 복사되는 것이 어긋나면 안 된다 — 한 곳에서 만든다.
  const snippet = `<script src="${scriptSrc}" data-feedloop="${botId}" async></script>`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const snippetBlock = (
    <>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-2.5">
        <code className="block min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-[10px] bg-muted px-3.5 py-3 font-mono text-xs leading-relaxed text-foreground">
          {snippet}
        </code>
        <Button onClick={handleCopy} className="shrink-0">
          {copied ? t('ww.copied') : t('ww.copy')}
        </Button>
      </div>

      {/* 복사 바로 밑이 「그래서 어디에?」가 떠오르는 자리다 */}
      <div className="flex flex-col overflow-hidden rounded-xl border border-border">
        {PLACES.map((p) => (
          <div
            key={p}
            className="grid gap-1 border-t border-border px-3.5 py-2.5 text-[12.5px] leading-relaxed first:border-t-0 sm:grid-cols-[118px_minmax(0,1fr)] sm:gap-3"
          >
            <b className="font-semibold">{t(`ww.places.${p}.where`)}</b>
            <span className="break-words font-mono text-[11.5px] text-muted-foreground">
              {t(`ww.places.${p}.how`, { body: '<body>', closeBody: '</body>' })}
            </span>
          </div>
        ))}
      </div>
    </>
  );

  return (
    <div className="flex max-w-[860px] flex-col gap-6">
      {connected ? (
        <>
          <ConnectedPanel
            title={t('ww.connected.title')}
            description={t('ww.connected.description')}
          >
            <Button asChild>
              <Link href="/inbox">{t('ww.viewInbox')}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={appearanceHref}>{t('ww.appearance')}</Link>
            </Button>
          </ConnectedPanel>

          {/* 다른 페이지나 다른 빌드에 또 붙일 일이 있다 — 감추지 말고 접어 둔다 */}
          <details className="border-t border-border pt-4">
            <summary className="cursor-pointer text-sm font-semibold">{t('ww.showScript')}</summary>
            <div className="mt-3 flex flex-col gap-3">{snippetBlock}</div>
          </details>
        </>
      ) : (
        <ConnectSteps>
          <ConnectStep state="now" index={1} title={t('ww.step1')}>
            {snippetBlock}
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {t('ww.step1Note')}
            </p>
            <WaitingLine
              polling={polling}
              onResume={resume}
              title={t('ww.waiting')}
              description={t('ww.waitingNote')}
            />
          </ConnectStep>
        </ConnectSteps>
      )}

      {/* 「붙였는데 안 떠요」 — 실제로 막히는 순서대로 적는다 */}
      <details className="border-t border-border pt-4">
        <summary className="cursor-pointer text-sm font-semibold">{t('ww.troubleshoot.title')}</summary>
        <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-[13px] leading-relaxed text-muted-foreground">
          <li>{t.rich('ww.troubleshoot.notDeployed', { b: (chunks) => <b className="font-semibold text-foreground">{chunks}</b> })}</li>
          <li>
            {t('ww.troubleshoot.cache')}
          </li>
          <li>
            {t.rich('ww.troubleshoot.edited', {
              code: (chunks) => <code className="rounded bg-muted px-1.5 py-px font-mono text-xs">{chunks}</code>,
            })}
          </li>
          <li>
            {t('ww.troubleshoot.loginOnly')}
          </li>
        </ul>
      </details>

      {!connected && (
        <p className="max-w-[66ch] text-[12.5px] leading-relaxed text-muted-foreground">
          {t.rich('ww.appearanceNote', {
            link: (chunks) => (
              <Link href={appearanceHref} className="font-semibold text-brand-strong hover:underline">
                {chunks}
              </Link>
            ),
          })}
        </p>
      )}
    </div>
  );
}
