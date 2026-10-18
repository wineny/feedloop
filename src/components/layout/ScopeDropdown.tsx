'use client';

// 헤더 서비스 셀렉터의 드롭다운. **네이티브 `<select>` 를 대신한다.**
//
// 겉(닫힌 버튼)은 CSS 로 맞출 수 있었지만 펼친 목록은 OS 가 그려서 손이 닿지 않았다 —
// 파란 하이라이트·시스템 글꼴·각진 모서리가 이 제품의 어느 화면과도 닮지 않았다(ny 지적).
// 그래서 목록까지 우리가 그린다.
//
// 🔴 네이티브를 버리면 «공짜로 따라오던 것»을 직접 챙겨야 한다. 여기서 챙긴 것:
//   · 키보드 — ↑↓ 이동, Home/End, Enter·Space 선택, Esc 닫기, Tab 으로 빠져나가기
//
// ⚠️ **글자 입력으로 찾기는 넣지 않았다.** 네이티브가 하던 일이라 처음엔 넣었는데, 한글에서
//    동작하지 않는다 — IME(입력기)를 거치는 글자는 `keydown` 이 아예 오지 않는다(2026-09-20 실측:
//    영문 `f` 는 Feedloop 으로 점프, 한글 「널」은 keydown 0건). 이 제품의 서비스 이름은 대부분
//    한글이라 «주로 쓰는 경우에 안 되는» 기능이 되고, 영문만 되는 채로 두면 될 때와 안 될 때가
//    갈려 더 나쁘다. 제대로 하려면 숨은 input 으로 조합 입력을 받아야 하는데, 한 계정의 서비스가
//    최대 10개(`MAX_BOTS_PER_USER`)인 목록에 그 구조는 과하다. ↑↓·Home·End 로 충분하다.
//   · 스크린리더 — combobox/listbox/option 역할과 `aria-activedescendant` 로 «지금 어디»를 알린다
//   · 바깥을 누르면 닫기, 닫을 때 포커스를 버튼으로 되돌리기
//
// 라이브러리(Radix 등)를 쓰지 않는다 — 심사 기간(9/21~10/5)에 새 의존성을 늘리지 않는다는
// 기존 판단을 따른다(`LoopStages` 가 이모지를 self-host 한 것과 같은 이유).
//
// 펼침 방향은 «아래» 하나뿐이다. 이 컴포넌트는 화면 맨 위 헤더에만 쓰여서 아래 공간이 늘 남는다.
// 다른 자리에 쓰게 되면 그때 위로 뒤집는 처리를 더할 것.

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ScopeOption {
  value: string;
  label: string;
}

export function ScopeDropdown({
  options,
  value,
  onPick,
  label,
  className,
}: {
  options: ScopeOption[];
  value: string;
  onPick: (next: string) => void;
  /** 화면에 글자로는 안 보이는 이름 — 스크린리더가 읽는다 */
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const currentIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const current = options[currentIndex];

  // 열 때 지금 고른 것에 커서를 얹는다. «여는 동작»에서 함께 하고 effect 로 미루지 않는다 —
  // effect 안에서 상태를 바꾸면 한 번 더 그리게 되고, 그 사이 커서가 옛 자리에 보인다.
  const openList = useCallback(() => {
    setActive(currentIndex);
    setOpen(true);
  }, [currentIndex]);

  // 포커스만 목록이 그려진 «뒤에» 옮긴다 — 키보드로 연 사람이 곧장 움직일 수 있게.
  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  // 바깥을 누르면 닫는다. `pointerdown` 이라 마우스·터치·펜이 같이 걸린다.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const close = useCallback((focusBack = true) => {
    setOpen(false);
    if (focusBack) buttonRef.current?.focus();
  }, []);

  const choose = useCallback(
    (index: number) => {
      const picked = options[index];
      if (!picked) return;
      onPick(picked.value);
      close();
    },
    [options, onPick, close],
  );

  const onListKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((i) => Math.min(options.length - 1, i + 1));
        return;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        return;
      case 'Home':
        e.preventDefault();
        setActive(0);
        return;
      case 'End':
        e.preventDefault();
        setActive(options.length - 1);
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        choose(active);
        return;
      case 'Escape':
        e.preventDefault();
        close();
        return;
      case 'Tab':
        // 막지 않는다 — 닫기만 하고 포커스는 다음 자리로 흘려보낸다.
        close(false);
        return;
    }
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        ref={buttonRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        onClick={() => (open ? close() : openList())}
        onKeyDown={(e) => {
          // 닫힌 채로 ↑↓ 를 누르면 연다 — 네이티브와 같은 몸짓이다.
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            openList();
          }
        }}
        className="flex h-9 w-full max-w-[116px] cursor-pointer items-center gap-1.5 rounded-full bg-muted pl-3.5 pr-2.5 text-[13px] font-semibold text-foreground outline-none transition-colors hover:bg-border focus-visible:ring-[3px] focus-visible:ring-ring/35 sm:max-w-[168px]"
      >
        <span className="min-w-0 flex-1 truncate text-left">{current?.label ?? ''}</span>
        <ChevronDown
          aria-hidden
          className={cn('h-3.5 w-3.5 shrink-0 text-faint transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={`${listId}-${active}`}
          onKeyDown={onListKeyDown}
          // 떠 있는 것이라 그림자를 쓴다 — 내부 카드는 그림자 없이 헤어라인만 쓰지만(v4 원칙),
          // 화면 위로 뜨는 요소는 이 제품도 그림자로 띄운다(데모 위젯·모달과 같은 잉크 계열).
          className="absolute right-0 top-full z-50 mt-1.5 min-w-[172px] max-w-[248px] overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-[0_8px_24px_rgba(25,29,27,.10)] outline-none"
        >
          {options.map((o, i) => {
            const selected = o.value === value;
            return (
              <div
                key={o.value}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={selected}
                onPointerEnter={() => setActive(i)}
                onClick={() => choose(i)}
                className={cn(
                  'flex h-9 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[13px] leading-none',
                  i === active ? 'bg-muted' : 'bg-transparent',
                  selected ? 'font-semibold text-foreground' : 'text-muted-foreground',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {selected && <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-brand-strong" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
