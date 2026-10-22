'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Wordmark } from '@/components/landing/Logo';
import { SiteStage } from './SiteStage';
import { useLocale, useTranslations } from 'next-intl';
import { INITIAL, getScript, isCustomerPage, type Frame, type Picked, type Scene, type Script } from './script';

/**
 * 가이드 데모 — 왼쪽 안내 패널 + 오른쪽 「고객이 보는 진짜 화면」 (ny 결정 2026-09-18 17:40)
 *
 * 한 번은 안내를 화면 «안»에 말풍선으로 띄웠는데, 널널투어 것인지 우리 것인지 구분이 안 됐다.
 * 그래서 안내는 다시 패널로 모으고, 화면 위에는 **반짝이는 링과 한 줄 지시만** 남긴다.
 * 왼쪽 = Feedloop 이 하는 말, 오른쪽 = 고객이 보는 화면. 경계가 색이 아니라 자리로 갈린다.
 *
 * 단계 목록은 **눌러서 앞뒤로 건너뛸 수 있다.** 뒤로 뛰면 그 사이 단계를 몰아서 적용하므로
 * 화면 상태는 언제나 그 단계에 맞다(중간을 건너뛴 채 남는 상태가 없다).
 *
 * 🔴 여기서 서버로 나가는 요청은 **하나도 없다.** 오른쪽 화면은 전부 떠 온 사본이다 —
 *    고객 쪽은 널널투어 전국 지도, 팀 쪽은 우리 앱의 `?demo=1` 연습용 화면 3장.
 *    거기 보이는 이름·건수는 지어낸 연습용 데이터라 실방문자 정보가 한 글자도 없다.
 */

/**
 * 프레임을 차례로 얹는다. 돌려주는 함수를 부르면 그 자리에서 멈춘다.
 * `instant` 면 기다리지 않고 남은 프레임을 몰아서 적용한다(건너뛰기 · 움직임 줄이기).
 */
function runFrames(
  frames: Frame[],
  from: number,
  instant: boolean,
  apply: (p: Frame['patch']) => void,
  onFrame: (i: number) => void,
  done: () => void,
): () => void {
  // 몰아칠 때는 남은 프레임을 하나로 접는다. 프레임마다 setTimeout(0) 을 걸면 브라우저가
  // 중첩 5단계부터 4ms 로 올려 잡아 타이핑 막이 0.45초쯤 걸리고 리렌더도 그만큼 난다.
  //
  // ⚠️ `from` 이 있는 이유 — 재생 «중»에 건너뛰기를 누르면 **남은 프레임만** 몰아야 한다.
  //    처음부터 다시 돌리면 말풍선을 더하는 프레임(`msgs: [...s.msgs, …]`)이 두 번 돌아
  //    같은 말이 두 번 붙는다.
  if (instant) {
    apply((s) => {
      let next = s;
      for (let k = from; k < frames.length; k++) {
        const p = frames[k].patch;
        next = { ...next, ...(typeof p === 'function' ? p(next) : p) };
      }
      return next;
    });
    onFrame(frames.length);
    done();
    return () => {};
  }

  let cancelled = false;
  let timer: ReturnType<typeof setTimeout>;
  let i = from;
  const step = () => {
    if (cancelled) return;
    if (i >= frames.length) {
      done();
      return;
    }
    const frame = frames[i];
    const at = i;
    timer = setTimeout(() => {
      if (cancelled) return;
      apply(frame.patch);
      i = at + 1;
      onFrame(i);
      step();
    }, frame.after);
  };
  step();
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

/** 0번부터 `upto` 직전까지를 몰아서 적용한 장면. 단계를 눌러 건너뛸 때 쓴다 */
function sceneAt(script: Script, upto: number): Scene {
  const { STEPS } = script;
  // 「화면에서 선택하기」로 집는 단계. 건너뛰어 왔을 때 이름을 채워 줘야 하는 자리다
  const POINT_STEP = STEPS.findIndex((s) => s.key === 'point');
  let s: Scene = { ...INITIAL };
  for (let i = 0; i < upto; i++) {
    for (const f of STEPS[i].frames) {
      s = { ...s, ...(typeof f.patch === 'function' ? f.patch(s) : f.patch) };
    }
  }
  // 집는 단계는 사람이 «직접» 누른 자리라 각본에 좌표가 없다. 건너뛰어 왔을 때만 이름을 채운다
  if (upto > POINT_STEP && !s.picked) s.picked = { x: 0, y: 0, w: 0, h: 0, label: script.POINT_LABEL };
  // 단계마다 서 있는 화면이 정해져 있다. 마지막 단계를 지나 끝났으면 각본이 남긴 화면 그대로 둔다
  const step = STEPS[upto];
  if (step) s.page = step.page;
  return s;
}

export function GuidedDemo({ onClose, inline = false }: { onClose?: () => void; inline?: boolean }) {
  const t = useTranslations('demo');
  // 언어마다 각본이 따로 있다(`script.en.ts` · `script.ko.ts`). 구조는 같고 말과 화면 사본만 다르다.
  const script = getScript(useLocale());
  const { STEPS } = script;
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const [scene, setScene] = useState<Scene>(INITIAL);
  /** -1 = 아직 시작 전 · STEPS.length = 다 봤다 */
  const [idx, setIdx] = useState(-1);
  const [playing, setPlaying] = useState(false);
  /** 화면 안에서 짚을 곳을 못 찾은 단계 — 버튼으로 넘긴다 */
  const [missing, setMissing] = useState(false);
  /** 모바일에서 단계 목록을 펼쳤나 */
  const [listOpen, setListOpen] = useState(false);
  /**
   * 고객 화면 → 팀 화면으로 넘어가는 1.5초. 제보가 우편물로 편지함에 들어가는 장면을 띄운다.
   *
   * ⚠️ 한때 편지함→묶음에도 «카드 셋이 날아와 포개지는» 장면을 넣었다가 걷어냈다
   *    — ny 「스무스하고 직관적이지가 않다」(2026-09-18). 지금은 그 자리에서 «편지함의 세 줄»을
   *    블록으로 짚는 단계(`similar`)가 대신한다. 움직이는 것보다 화면에 있는 것을 짚는 편이 읽힌다.
   */
  const [handoff, setHandoff] = useState(false);
  const handoffTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const stopRef = useRef<() => void>(() => {});
  /** 지금 몇 번째 프레임까지 얹었나 — 재생 중 건너뛰기가 그 «다음»부터 몰아친다 */
  const frameRef = useRef(0);
  const backdropDown = useRef(false);
  const reduceMotion = useRef(false);

  useEffect(() => {
    reduceMotion.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  // 부모(LandingNav)가 인라인 함수를 넘긴다. 효과 의존성에 두면 부모가 리렌더될 때마다
  // 효과가 다시 돌아 포커스가 닫기 버튼으로 끌려간다
  const closeCb = useRef(onClose);
  useEffect(() => {
    closeCb.current = onClose;
  });

  const apply = useCallback((patch: Frame['patch']) => {
    setScene((s) => ({ ...s, ...(typeof patch === 'function' ? patch(s) : patch) }));
  }, []);

  const step = idx >= 0 && idx < STEPS.length ? STEPS[idx] : null;
  const finished = idx >= STEPS.length;

  /** 눌렀다 — 그 단계의 재생을 돌리고, 끝나면 다음 단계로 */
  const advance = useCallback(
    (i: number, instant = false, from = 0) => {
      stopRef.current();
      setMissing(false);
      setPlaying(true);
      frameRef.current = from;
      stopRef.current = runFrames(
        STEPS[i].frames,
        from,
        instant || reduceMotion.current,
        apply,
        (n) => {
          frameRef.current = n;
        },
        () => {
          setPlaying(false);
          setIdx(i + 1);
          // 다음 단계가 서 있는 화면으로 옮긴다. 설명·링·화면이 같은 칸에 있어야 한다
          const next = STEPS[i + 1];
          if (!next) return;
          // 고객 쪽에서 팀 쪽으로 넘어갈 때만 «건너가는 장면»을 끼운다
          if (isCustomerPage(STEPS[i].page) && !isCustomerPage(next.page)) {
            setHandoff(true);
            clearTimeout(handoffTimer.current);
            handoffTimer.current = setTimeout(() => setHandoff(false), 1500);
          }
          setScene((s) => (s.page === next.page ? s : { ...s, page: next.page }));
        },
      );
    },
    [apply, STEPS],
  );

  /** 단계 목록을 눌러 그 자리로. 사이 단계는 몰아서 적용한다 */
  const jumpTo = useCallback((i: number) => {
    stopRef.current();
    setMissing(false);
    setPlaying(false);
    setListOpen(false);
    // 단계를 눌러 건너뛰면 건너가는 장면은 의미가 없다 — 바로 끈다
    clearTimeout(handoffTimer.current);
    setHandoff(false);
    frameRef.current = 0;
    setScene(sceneAt(script, i));
    setIdx(i);
  }, [script]);

  const handleHit = useCallback(() => {
    if (playing || !step) return;
    advance(idx);
  }, [advance, idx, playing, step]);

  const handlePick = useCallback(
    (p: Picked) => {
      if (playing || !step) return;
      setScene((s) => ({ ...s, picked: p }));
      advance(idx);
    },
    [advance, idx, playing, step],
  );

  useEffect(() => () => {
    stopRef.current();
    clearTimeout(handoffTimer.current);
  }, []);

  /**
   * 🔴 랜딩에는 **진짜 Feedloop 위젯이 붙어 있다**(도그푸딩, `SelfWidget.tsx`). 그 버튼은
   *    `z-index: 2147483000` 으로 오른쪽 아래에 떠 있어서, 데모 모달을 열면 **데모 속 챗봇
   *    버튼 바로 위를 덮는다** — 누르면 데모가 아니라 진짜 채팅창이 열린다.
   *
   *    숨기는 규칙(`body.gd-demo-open [data-feedloop-widget]`)은 `globals.css` 에 있는데,
   *    게임 튜토리얼로 갈아엎으면서(`462c425`) **그 클래스를 «켜는» 쪽이 같이 지워졌다.**
   *    규칙만 남고 켜는 데가 없어 내내 안 듣고 있었다(2026-09-18 실측에서 잡음).
   */
  useEffect(() => {
    // 🔴 박아 넣은 데모에는 걸지 않는다. 걸면 **랜딩을 보는 내내** 우리 위젯이 사라진다 —
    //    박아 넣은 무대의 가짜 위젯은 무대 «안»에만 있어서 애초에 겹치지 않는다.
    if (inline) return;
    document.body.classList.add('gd-demo-open');
    return () => document.body.classList.remove('gd-demo-open');
  }, [inline]);

  // 모달 기본기 — ESC 로 닫기 · 열릴 때 닫기 버튼에 포커스 · 탭이 밖으로 새지 않게
  useEffect(() => {
    // 🔴 박아 넣었을 때 포커스를 가져오면 **페이지가 열리자마자 데모로 스크롤이 튄다.**
    //    ESC 로 닫을 것도, 탭을 가둘 이유도 없다 — 그냥 페이지의 한 섹션이다.
    if (inline) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeCb.current?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const f = [...root.querySelectorAll<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])')].filter(
        (el) => !el.hasAttribute('disabled'),
      );
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [inline]);

  const heading = idx < 0 ? t('guided.intro') : finished ? t('guided.done') : (step?.title ?? '');

  /** 아래 버튼이 무엇을 하나 — 시작 · 건너뛰기 · 다음 단계 · 다시 보기 */
  const action =
    idx < 0
      ? { label: t('guided.start'), run: () => jumpTo(0) }
      : playing
        ? // 재생 중 건너뛰기는 «남은» 프레임만 몰아친다 — 처음부터 돌리면 같은 말이 두 번 붙는다
          { label: t('guided.playing'), run: () => advance(idx, true, frameRef.current) }
        : finished
          ? { label: t('guided.replay'), run: () => jumpTo(0) }
          : step && (!step.target || missing)
            ? { label: step.label ?? t('guided.continue'), run: () => advance(idx) }
            : { label: t('guided.skipStep'), run: () => advance(idx, true) };

  const stepList = (
    <ol className="flex flex-col gap-[1px]">
      {STEPS.map((s, i) => {
        const done = i < idx;
        const now = i === idx;
        return (
          <li key={s.key}>
            <button
              type="button"
              onClick={() => jumpTo(i)}
              className={`flex w-full items-start gap-2.5 rounded-[10px] px-2 py-1.5 text-left ${
                now ? 'bg-white' : 'hover:bg-white/70'
              }`}
            >
              <span
                className={`mt-[1px] flex h-5 w-5 flex-none items-center justify-center rounded-full text-[11px] font-bold ${
                  now
                    ? 'bg-[var(--coral-strong)] text-white'
                    : done
                      ? 'bg-[var(--ink)] text-white'
                      : 'border border-[var(--line)] bg-white text-[var(--faint)]'
                }`}
                aria-hidden="true"
              >
                {done ? '✓' : i + 1}
              </span>
              <span className={`min-w-0 text-[12.5px] leading-[1.5] ${now ? 'font-bold text-[var(--ink)]' : 'text-[var(--l-muted)]'}`}>
                {s.short}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );

  /**
   * 맨 처음 한 번은 버튼이 «눌러 달라고» 해야 한다 — 패널에 글이 많아서 가만히 두면
   * 어디서 시작하는지 못 찾는다(ny 지시 2026-09-18). 시작 전에만 코랄 + 맥박치는 링이고,
   * 한 번 누르면 평범한 버튼으로 돌아간다. 움직임 줄이기는 `.landing *` 규칙이 이미 끈다.
   *
   * ⚠️ 이 버튼«만»으로는 부족했다(ny 재지적). 진짜 시작 버튼은 오른쪽 화면 위에 따로 있다.
   */
  const first = idx < 0;
  const actionButton = (
    <button
      type="button"
      data-demo-action=""
      onClick={action.run}
      className={`flex h-11 w-full items-center justify-center gap-1.5 rounded-[12px] px-4 text-[13.5px] font-bold ${
        first ? 'border-0 bg-[var(--coral-strong)] text-white' : 'border border-[var(--line)] bg-white text-[var(--ink)]'
      }`}
      style={first ? { animation: 'gdAttn 1.9s ease-in-out infinite' } : undefined}
    >
      {playing && (
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--coral-strong)]" style={{ animation: 'gdDot 1s ease-in-out infinite' }} />
      )}
      {action.label}
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 12h14M13 6l6 6-6 6" />
      </svg>
    </button>
  );

  /**
   * 무대 본체. 팝업으로 띄울 때나 페이지에 박아 넣을 때나 **이것 하나**다 — 두 벌로 나누면
   * 한쪽만 고치는 일이 반드시 생긴다.
   */
  const shell = (
    <>
      <div
        ref={dialogRef}
        role={inline ? undefined : 'dialog'}
        aria-modal={inline ? undefined : true}
        aria-labelledby={titleId}
        className={
          inline
            ? 'flex min-h-0 flex-1 flex-col overflow-hidden bg-white'
            : 'flex h-full w-full flex-col overflow-hidden bg-white lg:h-[min(880px,94vh)] lg:max-w-[1340px] lg:rounded-[16px] lg:shadow-[0_40px_80px_rgba(25,29,27,.35)]'
        }
        onClick={inline ? undefined : (e) => e.stopPropagation()}
      >
        {/* 머리 */}
        <div className="flex flex-none items-center gap-3 border-b border-[var(--line)] px-4 py-2.5 lg:px-5">
          <div id={titleId} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-[14px] font-bold text-[var(--ink)]">
            <span>{t('guided.title')}</span>
            {/* 🔴 정직 표시 — 이게 각본이라는 걸 화면에서 숨기지 않는다 */}
            <span className="rounded-full bg-[var(--chip)] px-2 py-[2px] text-[11px] font-semibold text-[var(--l-muted)]">
              {t('guided.badge', { count: STEPS.length })}
            </span>
          </div>
          <div className="hidden flex-none items-center gap-1 sm:flex" aria-hidden="true">
            {STEPS.map((s, i) => (
              <span
                key={s.key}
                className={`h-1.5 rounded-full transition-all ${
                  i < idx ? 'w-1.5 bg-[var(--ink)]' : i === idx ? 'w-5 bg-[var(--coral-strong)]' : 'w-1.5 bg-[var(--line)]'
                }`}
              />
            ))}
          </div>
          <span className="flex-none text-[12px] font-semibold text-[var(--l-muted)]" aria-live="polite">
            {Math.min(Math.max(idx + 1, 0), STEPS.length)} / {STEPS.length}
          </span>
          {!inline && (
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label={t('guided.close')}
              className="flex h-9 w-9 flex-none items-center justify-center rounded-full text-[var(--ink)] hover:bg-[var(--chip)]"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[300px_minmax(0,1fr)]">
          {/* 안내 — 데스크톱 */}
          <aside className="hidden min-h-0 flex-col overflow-y-auto border-r border-[var(--line)] bg-[var(--chip)] p-5 lg:flex" aria-label={t('guided.stepsLabel')}>
            <div className="flex items-center gap-2 border-b border-[var(--line)] pb-3.5">
              <Wordmark markSize={22} className="text-[15px] font-extrabold tracking-[-0.02em] text-[var(--ink)]" />
            </div>

            <div role="status" aria-live="polite" className="pt-3.5" key={idx} style={{ animation: 'gdFade .3s ease' }}>
              <div className="text-[13px] font-bold text-[var(--coral-strong)]">
                {idx < 0 ? t('guided.clickToStart') : `${Math.min(idx + 1, STEPS.length)} / ${STEPS.length}`}
              </div>
              <h2 className="mt-1.5 text-[18px] font-bold leading-[1.35] text-[var(--ink)]" style={{ textWrap: 'pretty' }}>
                {heading}
              </h2>
            </div>

            <div className="mt-4">{stepList}</div>
            <p className="mt-2 pl-2 text-[11px] text-[var(--faint)]">{t('guided.stepsHint')}</p>

            {/* ⚠️ 여기 있던 긴 안내문을 ny 가 지우게 했다(2026-09-18). 「이건 시연용이고 실방문자
                정보가 아니다」라는 고지는 **떠 온 팀 화면 안의 「예시 데이터로 둘러보는 중이에요」
                배너**와 헤더의 「시연용 재생」 배지가 계속 진다 — 고지가 사라진 게 아니다. */}
            <div className="mt-auto pt-5">{actionButton}</div>
          </aside>

          {/* 안내 — 모바일: 위 한 줄로 접는다 */}
          <div className="flex-none border-b border-[var(--line)] bg-[var(--chip)] px-4 py-2.5 lg:hidden">
            <div className="flex items-center gap-2">
              <span className="flex-none text-[12px] font-bold text-[var(--coral-strong)]">
                {Math.min(Math.max(idx + 1, 1), STEPS.length)} / {STEPS.length}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-bold text-[var(--ink)]">{heading}</span>
              <button
                type="button"
                onClick={() => setListOpen((v) => !v)}
                className="flex-none text-[11.5px] font-semibold text-[var(--l-muted)]"
                aria-expanded={listOpen}
              >
                {t('guided.stepsToggle')} {listOpen ? '▴' : '▾'}
              </button>
            </div>
            {listOpen && <div className="mt-2 max-h-[40vh] overflow-y-auto">{stepList}</div>}
          </div>

          {/* 화면 */}
          <div className="relative min-h-0 flex-1 bg-[var(--chip)]">
            <SiteStage
              scene={scene}
              target={playing || missing ? null : (step?.target ?? null)}
              hint={step?.hint ?? ''}
              spot={playing ? null : (step?.spot ?? null)}
              handoff={handoff}
              onHit={handleHit}
              onPick={handlePick}
              onTargetMissing={() => setMissing(true)}
              onSkip={() => advance(idx, true)}
            />

            {/* 시작 전 — 오른쪽 화면 «위»에 큰 시작 버튼을 놓는다.
                🔴 패널 맨 아래 버튼만 두면 ny 눈에 안 띈다(2026-09-18 두 번 지적). 글이 많은 쪽이
                   아니라 **보고 있는 쪽**에 놓아야 찾는다. 누르면 사라지고 다시는 안 나온다. */}
            {idx < 0 && (
              <div className="absolute inset-0 z-[60] flex flex-col items-center justify-center gap-4 bg-[rgba(25,29,27,.55)] px-6 backdrop-blur-[2px]">
                <p className="max-w-[24rem] text-center text-[15px] font-semibold leading-[1.6] text-white" style={{ textWrap: 'pretty' }}>
                  {t('guided.intro')}
                </p>
                <button
                  type="button"
                  data-demo-start=""
                  onClick={action.run}
                  className="flex items-center gap-2 rounded-full bg-[var(--coral-strong)] px-7 py-4 text-[16px] font-extrabold text-white"
                  style={{ animation: 'gdAttn 1.7s ease-in-out infinite' }}
                >
                  {t('guided.start')}
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </button>
                <p className="text-center text-[12px] text-white/75">{t('guided.startNote', { count: STEPS.length })}</p>
              </div>
            )}
          </div>

          {/* 버튼 — 모바일은 맨 아래 */}
          <div className="flex-none border-t border-[var(--line)] bg-white px-4 py-3 lg:hidden">
            {actionButton}
            <p className="mt-2 text-center text-[11px] text-[var(--faint)]">{t('guided.copyNote')}</p>
          </div>
        </div>
      </div>
      {/*
        ⚠️ 설명은 CSS 안이 아니라 여기에 둔다 — `<style>` 안의 주석은 그대로 HTML 에 실려 나가서 영어 화면에 한국어가 남는다.
        · gdMail: 제보가 고객 화면에서 팀 편지함으로 «건너가는» 장면. 우편물은 도착지(편지함 그 줄)에 놓여 있고,
          --fl-dx/dy 만큼 떨어진 자리(위젯이 있던 오른쪽 아래)에서 날아온다. 가운데를 살짝 띄워 포물선을 그리고 마지막에 쏙 줄어든다.
        · gdBlock: 「이 셋이 같은 문제예요」 — 줄마다 하나씩 시차를 두고 켜진다. 동시에 켜면 한 덩어리로 보여서 «셋»이 안 읽힌다.
          각 칸의 animation-delay 는 SiteStage 가 넣는다.
        · 움직임 줄이기는 globals.css 의 .landing * 규칙(animation:none!important)이 이미 끈다 — 포털 루트에 landing 클래스가
          있어 여기까지 닿는다. 여기서 또 쓰지 않는다.
      */}
      <style>{`
        @keyframes gdDot{0%,100%{opacity:.3;transform:translateY(0)}50%{opacity:1;transform:translateY(-2px)}}
        @keyframes gdCaret{0%,49%{opacity:1}50%,100%{opacity:0}}
        @keyframes gdRise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
        @keyframes gdFade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
        @keyframes gdMail{
          0%  {opacity:0;transform:translate(-50%,-50%) translate(var(--fl-dx,0px),var(--fl-dy,0px)) scale(.5)}
          14% {opacity:1;transform:translate(-50%,-50%) translate(calc(var(--fl-dx,0px)*.86),calc(var(--fl-dy,0px)*.86 - 20px)) scale(1)}
          58% {opacity:1;transform:translate(-50%,-50%) translate(calc(var(--fl-dx,0px)*.16),calc(var(--fl-dy,0px)*.16 - 30px)) scale(1)}
          82% {opacity:1;transform:translate(-50%,-50%) translate(0px,0px) scale(.6)}
          100%{opacity:0;transform:translate(-50%,-50%) translate(0px,0px) scale(.34)}
        }
        @keyframes gdBlock{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:none}}
        @keyframes gdPulse{0%,100%{outline-color:#F2645C;outline-width:3px}50%{outline-color:#D13A2D;outline-width:5px}}
        @keyframes gdAttn{
          0%{box-shadow:0 0 0 0 rgba(242,100,92,.55);transform:translateY(0)}
          55%{box-shadow:0 0 0 10px rgba(242,100,92,0);transform:translateY(-1px)}
          100%{box-shadow:0 0 0 0 rgba(242,100,92,0);transform:translateY(0)}
        }
      `}</style>
    </>
  );

  /**
   * 랜딩에 **박아 넣기**(ny 2026-09-18 「우리가 방금 계속 만들었던 데모를 랜딩에 넣고 싶은거야」).
   * 포털도 검은 막도 닫기도 없이 페이지 흐름 안에 그대로 선다 — 내려오면 이미 떠 있다.
   * 높이를 못 박는 이유: 무대가 내용에 따라 늘었다 줄었다 하면 스크롤이 튄다.
   */
  if (inline) {
    return (
      <div className="landing" style={{ fontFamily: 'var(--font)' }}>
        <div className="flex h-[min(780px,84vh)] w-full flex-col overflow-hidden rounded-[14px] bg-white shadow-[0_10px_28px_rgba(25,29,27,.10)]">
          {shell}
        </div>
      </div>
    );
  }

  return createPortal(
    <div
      className="landing fixed inset-0 z-[100] flex items-stretch justify-center bg-[rgba(25,29,27,.6)] lg:items-center lg:p-6"
      style={{ fontFamily: 'var(--font)' }}
      // 모달 «안»에서 누르고 밖에서 떼면 click 은 공통 조상인 이 막에서 난다 — 글을 끌어
      // 선택하다 창이 닫힌다. 누르기도 여기서 시작했을 때만 닫는다.
      onMouseDown={(e) => {
        backdropDown.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // 이 막은 팝업일 때만 그려진다 — 박아 넣으면 닫을 것이 없어 `onClose` 도 안 넘어온다
        if (e.target === e.currentTarget && backdropDown.current) onClose?.();
      }}
    >
      {shell}
    </div>,
    document.body,
  );
}
