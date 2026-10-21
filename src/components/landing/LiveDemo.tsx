'use client';

import { useCallback, useState, type CSSProperties, type ReactNode } from 'react';
import { GuidedDemo } from '@/components/demo/guided/GuidedDemo';
import { useTranslations } from 'next-intl';

/**
 * 랜딩의 데모 «진입점»들.
 *
 * 🔴 2026-09-18 무대 본체가 여기서 나갔다. 예전엔 이 파일에 860줄짜리 데모가 들어 있었다 —
 *    널널투어 실서비스를 iframe 으로 띄우고 `/api/public/demo-track` 을 4초마다 폴링하는 물건이다.
 *    그걸 `src/components/demo/guided/` 의 각본 데모로 갈아 끼웠다(ny 「우리가 방금 계속 만들었던
 *    데모를 랜딩에 넣고 싶은거야」). 바뀐 점 셋 —
 *      · 심사 기간에 **남의 서비스가 흔들려도 데모는 그대로 뜬다**(전부 우리 주소의 사본이다)
 *      · 심사위원이 몇 번을 눌러도 **서버로 나가는 요청이 0** 이다
 *      · 고객 화면부터 메일함까지 한 바퀴가 각본으로 이어진다(11단계)
 *
 * 이 파일에 남은 것은 «어디로 데려가나» 뿐이다. 무대는 `GuidedDemo` 하나다.
 */

interface LiveDemoButtonProps {
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/**
 * 데모를 **팝업으로** 여는 버튼.
 *
 * ⚠️ 랜딩은 지금 이걸 안 쓴다 — 데모가 `DemoSection` 에 통째로 박혀 있어서 내려가면 이미 떠 있다.
 *    지우지 않고 두는 이유는 팝업 모드가 여전히 동작하고, 되돌릴 때 진입점만 다시 꽂으면 되기 때문.
 */
export function LiveDemoButton({ className, style, children }: LiveDemoButtonProps) {
  const t = useTranslations('landing');
  const [open, setOpen] = useState(false);
  const handleClose = useCallback(() => setOpen(false), []);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className} style={style}>
        {children ?? t('nav.demo')}
      </button>
      {open && <GuidedDemo onClose={handleClose} />}
    </>
  );
}

/**
 * 히어로·나브의 「데모」 — 팝업을 띄우지 않고 페이지 안 실물 임베드(`#try`)로 데려간다
 * (ny 결정 2026-09-18). 클릭 한 번을 아끼려는 게 아니라, 내려가면 «이미 떠 있는» 무대를
 * 보게 하려는 것이다.
 */
export function DemoAnchor({ className, style, children }: LiveDemoButtonProps) {
  const t = useTranslations('landing');
  return (
    <a
      href="#try"
      className={className}
      style={style}
      onClick={(e) => {
        e.preventDefault();
        scrollToHash('#try');
      }}
    >
      {children ?? t('nav.demo')}
    </a>
  );
}

/** 랜딩 안 앵커로 부드럽게 — 시스템이 움직임 줄이기를 켰으면 그냥 점프한다 */
export function scrollToHash(hash: string) {
  const el = document.querySelector<HTMLElement>(hash);
  if (!el) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  history.replaceState(null, '', hash);
}
