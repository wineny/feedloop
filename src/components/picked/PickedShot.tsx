'use client';

// 「화면에서 선택」 카드 — 방문자가 짚는 순간 찍은 화면 + 짚은 영역 테두리 (I-55, 2026-09-25).
// 대화 상세·피드백 행·수정안 근거 칸 세 곳이 이 하나를 쓴다. 이미지가 없으면(옛 제보·촬영 실패·보존 기간
// 경과) 같은 좌표로 미니맵을 그린다. 누르면 라이트박스(원본 전체 + 테두리 켜기/끄기 + Esc).
//
// 이미지 URL 은 운영자 라우트가 소유 확인 뒤 싣는 10분짜리 서명 URL 이다. 방문자에게는 안 나간다.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { ExternalLink, MapPin, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  frameOf,
  pagePathLabel,
  missingShotKind,
  thumbLayout,
  type PickedShotData,
} from '@/lib/widget/picked-shot';

const SIZES = {
  card: { w: 240, h: 160 },
  fact: { w: 112, h: 80 },
  row: { w: 96, h: 72 },
} as const;

type Size = keyof typeof SIZES;

/**
 * 방문자가 짚었던 페이지를 새 탭으로. 페이지만 연다 — 그 요소를 찾아 표시하지는 않는다(ny 결정 2026-09-25).
 * 지금의 페이지라 방문자가 본 화면과 다를 수 있어서 title 에 각주를 함께 싣는다.
 */
function PageLink({ url, tone }: { url: string; tone: 'card' | 'dark' }) {
  const t = useTranslations('picked');
  const path = pagePathLabel(url);
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${url}\n${t('pageLinkNote')}`}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'inline-flex min-w-0 items-center gap-1 font-semibold',
        tone === 'dark'
          ? 'shrink-0 rounded-full bg-white/15 px-2 py-1.5 text-[12.5px] text-white hover:bg-white/25 sm:px-3'
          : 'max-w-[240px] text-[12px] text-foreground underline-offset-2 hover:underline',
      )}
    >
      {tone === 'dark' ? (
        <>
          {/* 좁은 화면에선 아이콘만 — 제목(짚은 요소 이름)이 잘리지 않게. 이름은 스크린리더에 남긴다 */}
          <span className="sr-only sm:not-sr-only">{t('pageLinkLabel')}</span>
          <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
        </>
      ) : (
        <>
          <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
          <span className="shrink-0">{t('pageLinkLabel')}</span>
          <span className="truncate font-normal text-faint">{path}</span>
        </>
      )}
      <span className="sr-only">{tone === 'dark' ? ` ${t('newTabPath', { path })}` : ` ${t('newTab')}`}</span>
    </a>
  );
}

/** 테두리 — 코랄 선 + 옅은 채움. 작은 요소는 최소 상자에 핀을 얹는다 */
function Mark({ mark }: { mark: NonNullable<ReturnType<typeof thumbLayout>['mark']> }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute rounded-[3px] border-2 border-primary bg-primary/15 shadow-[0_0_0_1px_rgba(255,255,255,.7)]"
      style={{ left: mark.left, top: mark.top, width: mark.width, height: mark.height }}
    >
      {mark.small && (
        <MapPin className="absolute -top-4 left-1/2 h-3.5 w-3.5 -translate-x-1/2 fill-primary text-white" />
      )}
    </span>
  );
}

/** 썸네일(또는 미니맵) 한 장. 크기는 고정 상자, 내용은 짚은 영역을 가운데로 */
function Thumb({ data, size, onBroken }: { data: PickedShotData; size: Size; onBroken: () => void }) {
  const box = SIZES[size];
  const minimap = !data.shot;
  const l = thumbLayout(data, box, { contain: minimap });
  return (
    <span
      className={cn('relative block shrink-0 overflow-hidden rounded-[10px] border border-border', minimap ? 'bg-muted' : 'bg-background')}
      style={{ width: box.w, height: box.h }}
    >
      {data.shot ? (
        // eslint-disable-next-line @next/next/no-img-element -- 10분 서명 URL 이라 next/image 최적화 캐시에 태우지 않는다
        <img
          src={data.shot.url}
          alt=""
          draggable={false}
          onError={onBroken}
          className="absolute max-w-none select-none"
          style={{ left: l.img.left, top: l.img.top, width: l.img.width, height: l.img.height }}
        />
      ) : (
        <span
          aria-hidden
          className="absolute rounded-[4px] border border-border-strong bg-background"
          style={{ left: l.img.left, top: l.img.top, width: l.img.width, height: l.img.height }}
        />
      )}
      {l.mark && <Mark mark={l.mark} />}
    </span>
  );
}

function Lightbox({ data, onClose, onBroken }: { data: PickedShotData; onClose: () => void; onBroken: () => void }) {
  const t = useTranslations('picked');
  const [showMark, setShowMark] = useState(true);
  const closeRef = useRef<HTMLButtonElement>(null);
  // 부모가 다시 그릴 때마다(수정안 화면은 60초 폴링) 포커스를 닫기 버튼으로 끌어가지 않게 ref 로 든다(코드 리뷰 M5)
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const f = frameOf(data);
  const r = data.rect;
  const missing = missingShotKind(data);
  const lightboxReason = missing ? t(`missing.${missing}`) : null;

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, []);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('dialogLabel')}
      className="fixed inset-0 z-[100] flex flex-col bg-[rgba(25,29,27,.82)] p-4 sm:p-8"
      onClick={onClose}
    >
      <div className="mx-auto flex w-full max-w-[1200px] items-center gap-3 pb-3 text-white" onClick={(e) => e.stopPropagation()}>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{t('pickedLabel', { label: data.label })}</span>
        {data.pageUrl && <PageLink url={data.pageUrl} tone="dark" />}
        <button
          type="button"
          onClick={() => setShowMark((v) => !v)}
          className="shrink-0 rounded-full bg-white/15 px-3 py-1.5 text-[12.5px] font-semibold hover:bg-white/25"
          aria-pressed={showMark}
        >
          {showMark ? t('marksOff') : t('marksOn')}
        </button>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label={t('closeEsc')}
          className="shrink-0 rounded-full bg-white/15 p-1.5 hover:bg-white/25"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center" onClick={(e) => e.stopPropagation()}>
        {/* 판의 비율을 뷰포트로 고정하고 rect 는 % 로 얹는다 — 창 크기와 무관하게 맞는다 */}
        <div
          className="relative max-h-full max-w-full overflow-hidden rounded-[10px] bg-background"
          style={{ aspectRatio: `${f.w} / ${f.h}`, height: `min(100%, calc((100vw - 4rem) * ${f.h / f.w}))` }}
        >
          {data.shot ? (
            // eslint-disable-next-line @next/next/no-img-element -- 서명 URL
            <img src={data.shot.url} alt="" onError={onBroken} className="absolute inset-0 h-full w-full select-none" draggable={false} />
          ) : (
            <span className="absolute inset-0 bg-muted" aria-hidden />
          )}
          {showMark && r && (
            <span
              aria-hidden
              className="pointer-events-none absolute rounded-[3px] border-2 border-primary bg-primary/15"
              style={{
                left: `${(r.x / f.w) * 100}%`,
                top: `${(r.y / f.h) * 100}%`,
                width: `${(r.w / f.w) * 100}%`,
                height: `${(r.h / f.h) * 100}%`,
                minWidth: 12,
                minHeight: 12,
              }}
            />
          )}
        </div>
      </div>
      <p className="mx-auto pt-3 text-center text-[12.5px] text-white/70" onClick={(e) => e.stopPropagation()}>
        {data.shot ? t('footnote') : lightboxReason}
        {data.pageUrl && (
          <>
            <br />
            {t('pageLinkNoteSentence')}
          </>
        )}
      </p>
    </div>,
    document.body,
  );
}

/**
 * size='card' 는 설명 줄(라벨·셀렉터·각주)을 함께, 나머지는 썸네일만(라벨은 부모가 그린다).
 */
export function PickedShot({ data: given, size = 'card', className }: { data: PickedShotData; size?: Size; className?: string }) {
  const t = useTranslations('picked');
  const [open, setOpen] = useState(false);
  // 서명 URL(10분)이 만료되면 깨진 아이콘 대신 미니맵 폴백으로(코드 리뷰 M3). 새 URL 이 오면 다시 시도한다
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const data = given.shot && given.shot.url === brokenUrl ? { ...given, shot: null } : given;
  const markBroken = useCallback(() => setBrokenUrl(given.shot?.url ?? null), [given.shot?.url]);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    btnRef.current?.focus();
  }, []);
  const missing = missingShotKind(data);
  const reason = missing ? t(`missing.${missing}`) : null;
  const thumb = (
    <button
      ref={btnRef}
      type="button"
      onClick={() => setOpen(true)}
      className="group relative shrink-0 rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={t('viewLarge', { label: data.label })}
      title={size === 'card' ? undefined : `${data.label}${reason ? ` · ${reason}` : ''}`}
    >
      <Thumb data={data} size={size} onBroken={markBroken} />
    </button>
  );
  return (
    <>
      {size === 'card' ? (
        <div className={cn('flex max-w-full flex-col gap-1.5', className)}>
          {thumb}
          <span className="inline-flex min-w-0 items-center gap-1 text-[12.5px] font-medium text-brand-strong" title={data.selector}>
            <MapPin className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate">{t('pickedLabel', { label: data.label })}</span>
          </span>
          {data.pageUrl && <PageLink url={data.pageUrl} tone="card" />}
          <span className="max-w-[240px] text-[11.5px] leading-[1.45] text-faint">{reason ?? t('footnote')}</span>
        </div>
      ) : (
        <span className={className}>{thumb}</span>
      )}
      {open && <Lightbox data={data} onClose={close} onBroken={markBroken} />}
    </>
  );
}
