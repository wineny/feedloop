'use client';

// 봇 카드의 PR 모드 토글 — 등록 화면(/bots/new)의 라디오와 같은 두 선택지.
// 자동 모드는 매일 09:00(KST) 크론이 가장 큰 새 묶음 하나에 PR 을 연다.

import { useState } from 'react';
import { cn } from '@/lib/utils';

export type PrMode = 'approve' | 'auto';

interface PrModeControlProps {
  botId: string;
  initial: PrMode;
  disabled?: boolean;
}

const OPTIONS: { value: PrMode; label: string; hint: string }[] = [
  { value: 'approve', label: '승인 후 만들기', hint: '대시보드에서 [수정안 만들기]를 눌러야 만듭니다' },
  { value: 'auto', label: '자동으로 만들기', hint: '매일 09:00 가장 큰 새 묶음 하나에 수정안을 자동으로 올립니다' },
];

interface PrModeState {
  mode: PrMode;
  saving: boolean;
  error: string | null;
}

function usePrMode(botId: string, initial: PrMode) {
  const [state, setState] = useState<PrModeState>({ mode: initial, saving: false, error: null });

  async function save(next: PrMode) {
    const prev = state.mode;
    setState({ mode: next, saving: true, error: null });
    try {
      const res = await fetch(`/api/bots/${botId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pr_mode: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? '저장하지 못했습니다');
      }
      setState({ mode: next, saving: false, error: null });
    } catch (err) {
      // 실패하면 이전 값으로 되돌리고 이유를 보여준다.
      setState({
        mode: prev,
        saving: false,
        error: err instanceof Error ? err.message : '저장하지 못했습니다',
      });
    }
  }

  return { ...state, save };
}

export function PrModeControl({ botId, initial, disabled = false }: PrModeControlProps) {
  const { mode, saving, error, save } = usePrMode(botId, initial);
  const current = OPTIONS.find((o) => o.value === mode) ?? OPTIONS[0];

  function handleSelect(next: PrMode) {
    if (next === mode || saving || disabled) return;
    void save(next);
  }

  return (
    <div className="space-y-1.5">
      {/* 칸이 좁으면(≈190px 미만) 세그먼트가 통째로 다음 줄로 내려간다 — 버튼 안에서 글자가 꺾이지 않게 */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
        {/* 널널투어 v2: 세그먼트를 검정 채움 문법으로 — 선택 상태에 코랄 대신 foreground */}
        <span className="text-[12.5px] font-semibold text-muted-foreground">수정안 모드</span>
        <div
          role="radiogroup"
          aria-label="수정안 모드"
          className="inline-flex rounded-full border border-border-strong p-0.5"
        >
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={mode === o.value}
              disabled={disabled || saving}
              onClick={() => handleSelect(o.value)}
              className={cn(
                'whitespace-nowrap rounded-full px-3 py-1 text-[12.5px] font-semibold transition-colors disabled:cursor-not-allowed',
                mode === o.value ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {/* 칸이 좁아 두 줄이 되면 마지막 줄에 한 글자만 남기 쉽다 — text-pretty 가 줄을 고르게 나눈다 */}
      <p className="text-pretty text-[12.5px] leading-[1.45] text-muted-foreground">{error ?? current.hint}</p>
    </div>
  );
}
