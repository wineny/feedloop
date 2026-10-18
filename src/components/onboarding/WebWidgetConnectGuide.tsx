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
const PLACES: { where: string; how: string }[] = [
  { where: 'Next.js', how: 'app/layout.tsx 의 <body> 안, 닫는 태그 바로 앞' },
  { where: '정적 HTML', how: '각 페이지의 </body> 직전' },
  { where: '워드프레스', how: '외모 → 테마 파일 편집기 → footer.php 의 </body> 앞 (또는 헤더/푸터 스크립트 플러그인)' },
  { where: 'Webflow · 카페24', how: '프로젝트 설정 → Custom Code → Footer Code (카페24는 디자인 → 공통 레이아웃)' },
];

export function WebWidgetConnectGuide({
  botId,
  scriptSrc,
  appearanceHref,
  initiallyConnected,
}: WebWidgetConnectGuideProps) {
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
          {copied ? '복사됨' : '복사'}
        </Button>
      </div>

      {/* 복사 바로 밑이 「그래서 어디에?」가 떠오르는 자리다 */}
      <div className="flex flex-col overflow-hidden rounded-xl border border-border">
        {PLACES.map((p) => (
          <div
            key={p.where}
            className="grid gap-1 border-t border-border px-3.5 py-2.5 text-[12.5px] leading-relaxed first:border-t-0 sm:grid-cols-[118px_minmax(0,1fr)] sm:gap-3"
          >
            <b className="font-semibold">{p.where}</b>
            <span className="break-words font-mono text-[11.5px] text-muted-foreground">
              {p.how}
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
            title="위젯이 떠 있어요"
            description="방문자가 남긴 말에 AI가 그 자리에서 답하고, 남은 피드백은 「대화」에 쌓입니다."
          >
            <Button asChild>
              <Link href="/inbox">대화 보기</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={appearanceHref}>모양 바꾸기</Link>
            </Button>
          </ConnectedPanel>

          {/* 다른 페이지나 다른 빌드에 또 붙일 일이 있다 — 감추지 말고 접어 둔다 */}
          <details className="border-t border-border pt-4">
            <summary className="cursor-pointer text-sm font-semibold">스크립트 다시 보기</summary>
            <div className="mt-3 flex flex-col gap-3">{snippetBlock}</div>
          </details>
        </>
      ) : (
        <ConnectSteps>
          <ConnectStep state="now" index={1} title="스크립트 한 줄 붙여넣기">
            {snippetBlock}
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              개발자에게 넘길 거라면 위 줄을 그대로 전달하면 됩니다. 로그인 여부와 상관없이 모든
              방문자에게 보이고, 붙인 페이지를 한 번 열면 이 화면이 자동으로 바뀝니다.
            </p>
            <WaitingLine
              polling={polling}
              onResume={resume}
              title="위젯이 처음 뜨길 기다리는 중…"
              description="스크립트를 붙인 페이지를 한 번 열어보세요. 위젯이 로드되면 여기가 바뀝니다."
            />
          </ConnectStep>
        </ConnectSteps>
      )}

      {/* 「붙였는데 안 떠요」 — 실제로 막히는 순서대로 적는다 */}
      <details className="border-t border-border pt-4">
        <summary className="cursor-pointer text-sm font-semibold">붙였는데 안 떠요</summary>
        <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-[13px] leading-relaxed text-muted-foreground">
          <li>
            저장만 하고 <b className="font-semibold text-foreground">배포를 아직 안 했을 수 있어요.</b>{' '}
            Vercel·Netlify 같은 곳은 배포가 끝나야 반영됩니다.
          </li>
          <li>
            브라우저가 옛 페이지를 들고 있을 수 있어요. 새로고침을 한 번 강하게(⌘⇧R) 해 보세요.
          </li>
          <li>
            스니펫을 손으로 고쳐 적었다면 <code className="rounded bg-muted px-1.5 py-px font-mono text-xs">data-feedloop</code>{' '}
            값이 위와 똑같은지 확인해 주세요. 한 글자만 달라도 우리 쪽에 도착하지 않습니다.
          </li>
          <li>
            로그인한 사람에게만 보이는 레이아웃에 넣었다면, 로그아웃 상태에서는 안 뜹니다.
          </li>
        </ul>
      </details>

      {!connected && (
        <p className="max-w-[66ch] text-[12.5px] leading-relaxed text-muted-foreground">
          위젯 이름·인사말·색은 연결한 뒤{' '}
          <Link href={appearanceHref} className="font-semibold text-brand-strong hover:underline">
            모양 바꾸기
          </Link>
          에서 고칠 수 있어요.
        </p>
      )}
    </div>
  );
}
