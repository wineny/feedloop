'use client';

import Image from 'next/image';
import { useEffect, useRef } from 'react';
import type { Scene } from './script';

/**
 * 떠 온 널널투어 화면 «위»에 얹는 Feedloop 위젯 그림.
 *
 * 왜 진짜 `widget.js` 를 안 쓰나 — 그건 널널투어 실서비스에 이미 나가 있는 파일이고(동결),
 * 붙는 순간 서버로 요청이 나간다. 데모는 서버를 건드리지 않는다. 대신 생김새는 **널널투어에
 * 실제로 붙어 있는 위젯 그대로** 맞춘다(2026-09-18 ny 화면에서 확인) — 브랜드 초록 `#408D66` ·
 * 만복이 프로필 · 「보통 몇 분 안에 답해요」 · 「Powered by Feedloop」. 위젯 색은 봇마다 정하는
 * 값이라 Feedloop 코랄이 아니라 «그 사이트의 색»이 나온다. 여기서 코랄을 쓰면 실제로 붙어 있는
 * 것과 다른 물건이 된다. 치수는 `public/widget.js` 의 CSS 와 같다(56px 버튼 · 320px 창 · 14px 모서리).
 *
 * 튜토리얼이 「이걸 누르세요」 하고 가리키는 자리가 여기 셋이다 — `fab` · `input` · `pick`.
 * 그 자리는 링을 씌워야 해서 밖에서 잴 수 있게 ref 를 올려 보낸다.
 */

/**
 * 링을 씌울 수 있는 위젯 부품.
 * `card` 는 루프가 닫혔다는 「반영됐어요」 카드다 — 마지막에 **그 카드 자체를 짚어** 「말한 자리로
 * 답이 왔다」를 못 박는다(2026-09-18). 그 전엔 카드가 뜨자마자 다음 화면에 덮여 안 보였다.
 */
export type WidgetPart = 'fab' | 'input' | 'pick' | 'card';

/** 널널투어 위젯 프로필 — ny 가 만든 만복이. 실제로 붙어 있는 것과 같은 얼굴을 쓴다 */
const AVATAR = '/demo/manbok/avatar.png';

interface Props {
  scene: Scene;
  /** 지금 눌러야 하는 곳. 위젯 쪽이 아니면 null */
  want: WidgetPart | null;
  onHit: () => void;
}

/** 위젯 안 말풍선 한 줄. `.bub.me` / `.bub.us` 와 같은 모양 */
function Bubble({
  who,
  text,
  card,
  onCard,
}: {
  who: 'me' | 'ai';
  text: string;
  card?: boolean;
  /** 카드를 짚는 단계라면 누를 수 있게 넘어온다 */
  onCard?: () => void;
}) {
  if (who === 'me') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-[14px] rounded-br-[4px] bg-[#191d1b] px-[13px] py-2.5 text-[13.5px] leading-[1.55] text-white">
          {text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <Image src={AVATAR} alt="" width={22} height={22} unoptimized className="h-[22px] w-[22px] flex-none rounded-full object-cover" />
        <span className="text-[11px] font-bold text-[#6e6968]">널널투어</span>
        <span className="rounded-full bg-[#EAF3EE] px-1.5 py-[1px] text-[9.5px] font-bold text-[#2f6b4c]">AI</span>
      </div>
      <div className="ml-[28px] flex flex-col gap-1.5">
        <div className="max-w-[92%] rounded-[14px] rounded-bl-[4px] bg-[#f6f3f2] px-[13px] py-2.5 text-[13.5px] leading-[1.55] text-[#191d1b]">
          {text || <span className="text-[#a39d9b]">…</span>}
        </div>
        {card && (
          // 루프가 닫혔다는 표시. 실물 위젯의 `.card`(코랄 틴트 + 체크)와 같은 결
          <div
            data-part="card"
            onClick={onCard}
            className={`flex max-w-[92%] flex-col gap-1 rounded-[14px] border border-[#D6E7DD] bg-[#EAF3EE] px-3.5 py-3 ${onCard ? 'cursor-pointer' : ''}`}
          >
            <div className="flex items-center gap-1.5">
              <span className="flex h-[17px] w-[17px] flex-none items-center justify-center rounded-full bg-[#408D66]">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 12l6 6L20 6" />
                </svg>
              </span>
              <span className="text-[12px] font-bold text-[#2f6b4c]">반영됐어요</span>
            </div>
            {/* ny 문장(2026-09-18 5차). 「내가 남긴 말 때문에 고쳐졌어요」는 원인을 내 탓처럼 읽히게 했다 —
                이 카드가 말해야 하는 것은 **내 피드백이 제품을 움직였다**는 쪽이다.
                ⚠️ 실물 위젯(`public/widget.js` `systemCard`)의 되돌림 카드는 이 줄을 갖고 있지 않다 —
                   거기 본문은 서버가 보낸 「고쳐서 올렸어요…」 한 줄이다. 즉 이 줄은 «데모에만 있는»
                   설명이라 여기서 바꿔도 제품과 갈라지지 않는다.
                   머리글 「반영됐어요」는 실물과 «같다» — 실물도 2026-09-18 에 「수정 PR이 머지됐어요」
                   에서 이 말로 바뀌었다(main `7330ccd`). 한쪽만 고치면 그때부터 갈라진다. */}
            <span className="text-[11.5px] leading-[1.5] text-[#6e6968]">나의 피드백 덕분에 서비스가 개선되었어요</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** 점 세 개 — AI 가 답을 쓰는 중 */
function Dots() {
  return (
    <div className="ml-[28px] flex w-fit items-center gap-1 rounded-[14px] rounded-bl-[4px] bg-[#f6f3f2] px-3.5 py-3">
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-1.5 w-1.5 rounded-full bg-[#a39d9b]" style={{ animation: `gdDot 1s ease-in-out ${i * 0.16}s infinite` }} />
      ))}
    </div>
  );
}

export function Widget({ scene, want, onHit }: Props) {
  const { widgetOpen, draft, msgs, thinking, picking, attached, picked } = scene;
  const chatRef = useRef<HTMLDivElement>(null);

  /**
   * 대화가 길어지면 스스로 아래로 따라간다. 없으면 이 데모의 결론인 마지막
   * 「반영됐어요」 카드가 화면 밖에 남는다(2026-09-18 리뷰).
   */
  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, thinking, attached, widgetOpen]);

  const hit = (part: WidgetPart) => (want === part ? onHit : undefined);
  /** 지금 눌러야 하는 곳만 손 모양이 된다 — 나머지는 그림이다 */
  const ptr = (part: WidgetPart) => (want === part ? 'cursor-pointer' : '');

  // 🔴 선택 중에는 창을 통째로 숨긴다 — **실물이 그렇게 한다**(`widget.js` 의 `startPick`:
  //    `wrap.style.display = 'none'`). 창 뒤를 짚어야 하니 당연한 동작인데, 데모에서 빼먹었더니
  //    320×430 창이 화면을 덮어 좁은 화면에서는 짚을 자리가 아예 남지 않았다(390px 실측).
  const showPanel = widgetOpen && !picking;

  return (
    <div className="pointer-events-none absolute bottom-4 right-4 top-4 z-20 flex flex-col items-end justify-end gap-3">
      {showPanel && (
        <div
          data-widget-panel=""
          className="pointer-events-auto flex h-[min(430px,calc(100%-8px))] w-[min(320px,calc(100vw-40px))] flex-col overflow-hidden rounded-[14px] bg-white shadow-[0_24px_64px_rgba(25,29,27,.2),0_4px_16px_rgba(25,29,27,.08)]"
          style={{ animation: 'gdRise .26s cubic-bezier(.2,.7,.2,1)' }}
        >
          {/* 머리 */}
          <div className="flex flex-none items-center gap-2.5 border-b border-[#eeeae9] px-3.5 py-3">
            <Image src={AVATAR} alt="" width={30} height={30} unoptimized className="h-[30px] w-[30px] flex-none rounded-full object-cover" />
            <div className="min-w-0">
              <div className="text-[13.5px] font-bold leading-tight text-[#191d1b]">널널투어</div>
              <div className="text-[11px] leading-tight text-[#6e6968]">보통 몇 분 안에 답해요</div>
            </div>
          </div>

          {/* 대화 */}
          <div ref={chatRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 py-3.5">
            {msgs.map((m, i) => (
              <Bubble key={i} who={m.who} text={m.text} card={m.card} onCard={m.card ? hit('card') : undefined} />
            ))}
            {thinking && <Dots />}
          </div>

          {/* 붙은 화면 조각 — 사람이 «실제로 누른» 자리의 이름이 들어온다 */}
          {attached && (
            <div className="flex flex-none items-center gap-2 border-t border-[#eeeae9] bg-[#EAF3EE] px-3 py-2">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2f6b4c" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="3" />
                <path d="M3 15l5-4 4 3 3-2 6 5" />
              </svg>
              <span className="truncate text-[11.5px] font-semibold text-[#2f6b4c]">
                화면 조각 1장이 붙었어요{picked?.label ? ` · ${picked.label}` : ''}
              </span>
            </div>
          )}

          {/* 도구 알약 — 실물 위젯은 입력칸 «위»에 이 줄이 있다(widget.js `.tool`).
              「화면에서 선택하기」는 진짜로 있는 기능이다(`public/widget-pick.js`). */}
          <div className="flex flex-none items-center gap-1.5 border-t border-[#eeeae9] px-2.5 pt-2">
            <button
              type="button"
              data-part="pick"
              onClick={hit('pick')}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-[5px] text-[11.5px] font-semibold ${ptr('pick')} ${
                picking ? 'border-[#D6E7DD] bg-[#EAF3EE] text-[#2f6b4c]' : 'border-[#eeeae9] bg-white text-[#3f4a44]'
              }`}
            >
              {/* 실물 위젯과 같은 아이콘 — 조준점 */}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
              </svg>
              {picking ? '선택하는 중…' : '화면에서 선택하기'}
            </button>
            <span className="inline-flex items-center gap-1 rounded-full border border-[#eeeae9] bg-white px-2.5 py-[5px] text-[11.5px] font-semibold text-[#3f4a44]">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="8" r="3.4" />
                <path d="M5 20c0-3.6 3.1-5.6 7-5.6s7 2 7 5.6" />
              </svg>
              상담원 연결
            </span>
          </div>

          {/* 입력칸 */}
          <div className="flex flex-none items-end gap-2 px-2.5 pb-2.5 pt-2">
            <button
              type="button"
              data-part="input"
              onClick={hit('input')}
              className={`min-h-[38px] flex-1 rounded-[12px] border border-[#eeeae9] px-3 py-2 text-left text-[13px] leading-[1.5] text-[#191d1b] ${ptr('input')}`}
            >
              {draft ? (
                <>
                  {draft}
                  <span className="ml-[1px] inline-block h-[14px] w-[1.5px] translate-y-[2px] bg-[#191d1b]" style={{ animation: 'gdCaret 1s steps(1) infinite' }} />
                </>
              ) : (
                <span className="text-[#a39d9b]">무엇이든 편하게 남겨주세요</span>
              )}
            </button>
            <span className="flex-none rounded-[12px] bg-[#408D66] px-3.5 py-2 text-[12.5px] font-bold text-white">보내기</span>
          </div>

          {/* 실물 위젯에 있는 줄 — 남의 사이트에 붙은 우리 물건이라는 표시 */}
          <div className="flex-none px-3 pb-2 text-right text-[10.5px] text-[#a39d9b]">Powered by Feedloop</div>
        </div>
      )}

      {/* 동그란 버튼 — 창이 열리면 실물 위젯처럼 숨는다(`.wrap.open .fab`).
          선택 중에도 안 뜬다 — 실물은 `wrap` 을 통째로 숨겨서 버튼도 같이 사라진다 */}
      {!widgetOpen && !picking && (
        <button
          type="button"
          data-part="fab"
          onClick={hit('fab')}
          aria-label="Feedloop 열기"
          className={`pointer-events-auto flex h-14 w-14 items-center justify-center rounded-full bg-[#408D66] shadow-[0_8px_24px_rgba(25,29,27,.18)] ${ptr('fab')}`}
        >
          {/* 닫힌 버튼은 **프로필 사진**이다 — 실물이 그렇다(`widget.js` 의 `.fab img`:
              56px · 흰 테두리 3px, 프로필이 없을 때만 이니셜, 그것도 없을 때만 말풍선 아이콘).
              말풍선 아이콘으로 그려 뒀더니 만복이가 창을 열어야 나타났다(ny 지적 2026-09-18). */}
          <Image
            src={AVATAR}
            alt=""
            width={56}
            height={56}
            unoptimized
            className="box-border h-14 w-14 rounded-full border-[3px] border-white object-cover"
          />
        </button>
      )}
    </div>
  );
}

