// 연결 단계 목록 — 채널톡 3단계와 웹 위젯 1단계가 같은 문법을 쓴다.
//
// 왜 프리미티브로 뺐나. 예전 화면은 **키를 저장해야 「붙이는 순서」가 나타났다** — 운영자는
// 총 몇 단계인지 모른 채 첫 칸을 채우고, 저장하고 나서야 남은 일이 셋 더 있다는 걸 알았다.
// 단계는 처음부터 다 보이고 각자 상태를 갖는다: 지나온 것은 한 줄로 접혀 체크가 되고,
// 지금 할 것만 펼쳐지고, 아직인 것은 제목만 회색으로 자리를 지킨다.

import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export type StepState = 'done' | 'now' | 'todo';

interface StepProps {
  state: StepState;
  /** 1부터 센다. `done` 이면 숫자 대신 체크가 뜬다 */
  index: number;
  title: string;
  /** 본문. `todo` 단계는 한 줄 예고만 두고 내용은 비워 둔다 */
  children?: ReactNode;
}

/** 단계 하나. 헤어라인으로 갈리고 왼쪽 30px 에 마커가 선다. */
export function ConnectStep({ state, index, title, children }: StepProps) {
  return (
    <div className="grid grid-cols-[30px_minmax(0,1fr)] gap-4 border-t border-border py-5 first:border-t-0 first:pt-1">
      <div className="flex items-start pt-px">
        <span
          className={cn(
            'inline-flex h-[22px] w-[22px] items-center justify-center rounded-full border text-xs font-bold tabular-nums',
            state === 'done' && 'border-primary bg-primary text-primary-foreground',
            state === 'now' && 'border-primary bg-brand-subtle text-brand-strong',
            state === 'todo' && 'border-border-strong bg-background text-faint',
          )}
        >
          {state === 'done' ? <Check className="h-3 w-3" aria-hidden /> : index}
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <h3
          className={cn(
            'text-[15px] font-semibold tracking-[-0.012em]',
            state === 'todo' && 'text-muted-foreground',
          )}
        >
          {title}
        </h3>
        {children}
      </div>
    </div>
  );
}

/** 단계들을 감싼다. 첫 단계의 윗 헤어라인은 `ConnectStep` 쪽에서 지운다. */
export function ConnectSteps({ children }: { children: ReactNode }) {
  return <div className="flex flex-col">{children}</div>;
}

/**
 * 단계 안의 절차 — 「채널톡에서 이렇게 누르세요」처럼 **우리 화면 밖에서** 할 일.
 * 우리 단계(큰 마커)와 남의 화면 절차(작은 번호)는 층이 달라 모양도 다르다.
 */
export function Howto({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border">{children}</div>
  );
}

export function HowtoStep({ index, children }: { index: number; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[18px_minmax(0,1fr)] gap-3 border-t border-border px-3.5 py-3 text-[13px] leading-relaxed text-muted-foreground first:border-t-0">
      <i className="pt-0.5 text-xs font-bold not-italic tabular-nums text-faint">{index}</i>
      <span>{children}</span>
    </div>
  );
}

/** 남의 화면에서 눌러야 할 것. 본문 글자와 섞이지 않게 칩으로 띄운다. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-[5px] bg-muted px-1.5 py-px text-[12.5px] font-semibold text-foreground">
      {children}
    </kbd>
  );
}
