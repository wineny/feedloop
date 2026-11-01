'use client';

/**
 * 연습용 화면에서 **지금 눌러야 할 것 하나**를 짚어 준다.
 *
 * 왜 필요한가 — 라이브 데모는 심사위원이 처음 보는 화면이다. 왼쪽에 글로 「답장을 보내보세요」라고
 * 적어 둬도, 오른쪽 화면 어디에 그 칸이 있는지는 안 보인다. 실제로 ny 가 데모를 눌러 보다가
 * 「어디에 쓰라는 건지 모르겠다」에서 막혔다(2026-09-18). 그래서 글 대신 «그 자리»를 짚는다.
 *
 * 쓰는 법 — 짚을 대상을 `relative` 로 감싸고 그 안에 둔다. 테두리와 말풍선 모두 클릭을 통과시키므로
 * (`pointer-events-none`) 정작 눌러야 할 버튼을 가로막지 않는다.
 *
 * ⚠️ 연습용 화면에서만 쓴다. 진짜 운영 화면에 이게 뜨면 운영자에게 훈수를 두는 꼴이 된다.
 *
 * ⚠️ 여기서 그리는 것들에는 전부 `data-demo-hint` 가 붙어 있다. **랜딩 가이드 데모가 이 화면을
 *    떠 갈 때 캡처기가 그걸 보고 걷어낸다**(`scripts/capture-nulnul.mjs`). 튜토리얼은 자기
 *    링을 따로 씌우는데 사본에 이 링까지 박혀 있으면 빨간 링이 두 개가 되어 어디를 누르라는
 *    건지 알 수 없다(ny 지적 2026-09-18). 속성 이름을 바꾸면 캡처기도 같이 고쳐야 한다.
 */
interface DemoHintProps {
  /** 끌 수 있어야 한다 — 한 화면에 두 곳이 동시에 깜빡이면 어디를 보라는지 알 수 없다. */
  show?: boolean;
  /** 말풍선 문구. 없으면 테두리만 그린다. */
  label?: string;
  /** 말풍선을 어디에 붙일지. 대상이 화면 아래쪽이면 `top`, 좁은 줄 안이면 `right`. */
  placement?: 'top' | 'right';
}

export function DemoHint({ show = true, label, placement = 'top' }: DemoHintProps) {
  if (!show) return null;

  return (
    <>
      <span
        aria-hidden="true"
        data-demo-hint=""
        className="pointer-events-none absolute -inset-1 rounded-[14px] ring-2 ring-[#D13A2D]"
        style={{ animation: 'demoHintPulse 1.6s ease-in-out infinite' }}
      />
      {label && (
        <span
          // 화면 낭독기에는 안 읽힌다 — 같은 말이 옆 안내에 이미 글로 있고, 여기선 «자리»만 짚는다.
          aria-hidden="true"
          data-demo-hint=""
          className={
            placement === 'top'
              ? 'pointer-events-none absolute -top-3 left-3 z-10 -translate-y-full whitespace-nowrap rounded-full bg-[#D13A2D] px-2.5 py-1 text-[12px] font-bold text-white shadow-[0_4px_12px_rgba(209,58,45,.35)]'
              // 폰 폭(<640px)엔 오른쪽 자리가 없어 말풍선이 화면 밖으로 잘린다(375px 에서 21px) → 그때만 위에 붙인다
              : 'pointer-events-none absolute -top-3 left-3 z-10 -translate-y-full sm:left-[calc(100%+10px)] sm:top-1/2 sm:-translate-y-1/2 whitespace-nowrap rounded-full bg-[#D13A2D] px-2.5 py-1 text-[12px] font-bold text-white shadow-[0_4px_12px_rgba(209,58,45,.35)]'
          }
          style={{ animation: 'demoHintPulse 1.6s ease-in-out infinite' }}
        >
          {label}
        </span>
      )}
      {/* 움직임 줄이기를 켠 사람에게는 깜빡이지 않는다 — 테두리는 그대로 보인다. */}
      <style data-demo-hint="">{`
        @keyframes demoHintPulse { 0%,100% { opacity: .45 } 50% { opacity: 1 } }
        @media (prefers-reduced-motion: reduce) { @keyframes demoHintPulse { 0%,100% { opacity: 1 } } }
      `}</style>
    </>
  );
}
