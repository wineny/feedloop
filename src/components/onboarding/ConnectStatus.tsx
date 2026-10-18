'use client';

// 연결 상태 두 모양 — 기다리는 중 / 연결됨.
//
// 예전 `ConnectionCard` 는 둘을 한 컴포넌트가 그렸는데, 새 화면에서는 놓이는 자리가 다르다.
// **기다리는 중**은 단계 «안»의 한 줄이고(아직 그 단계를 하는 중이니까),
// **연결됨**은 단계를 «대신하는» 카드다(할 일이 끝났으니 단계가 사라진다).
// 자리가 다르면 모양도 달라야 해서 나눴다.
//
// 폴링 상한과 「다시 확인」은 그대로 가져왔다 — 탭을 열어 둔 채 방치해도 무한 폴링하지 않고,
// 멈춘 뒤에는 운영자가 직접 재개한다.

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface WaitingLineProps {
  polling: boolean;
  onResume: () => void;
  /** 무엇을 기다리는지. 예: 「첫 웹훅을 기다리는 중…」 */
  title: string;
  /** 지금 운영자가 해야 할 것 */
  description: string;
}

/** 단계 안에 놓는 대기 줄. 점이 뛰는 동안은 우리가 보고 있다는 뜻이다. */
export function WaitingLine({ polling, onResume, title, description }: WaitingLineProps) {
  // aria-live: 「기다리는 중 → 연결됐어요」는 이 화면이 주는 유일한 완료 신호인데
  // 여태 시각 전용이었다. 스크린리더 사용자는 연결이 됐는지 알 방법이 없었다.
  return (
    <div className="flex flex-col gap-1.5" role="status" aria-live="polite">
      <p className="inline-flex items-center gap-2 text-[13px] font-semibold text-muted-foreground">
        {polling && (
          <i className="block h-1.5 w-1.5 animate-pulse rounded-full bg-faint" aria-hidden />
        )}
        {polling ? title : '자동 확인을 잠시 멈췄습니다'}
      </p>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        {polling
          ? description
          : '오래 기다려서 자동 확인을 중단했습니다. 연결을 마친 뒤 다시 확인을 눌러주세요.'}
      </p>
      {!polling && (
        <div>
          <Button variant="outline" size="sm" onClick={onResume} className="mt-1.5">
            다시 확인
          </Button>
        </div>
      )}
    </div>
  );
}

interface ConnectedPanelProps {
  /** 「51e2d 채널에서 문의가 들어오고 있어요」처럼 **지금 무슨 일이 일어나는지** */
  title: string;
  /** 그래서 운영자가 알아야 할 것 */
  description: ReactNode;
  /** 다음 행동 버튼들 */
  children?: ReactNode;
}

/** 연결이 끝나면 단계를 대신하는 카드. 이 화면에서 코랄 테두리는 여기 하나뿐이다. */
export function ConnectedPanel({ title, description, children }: ConnectedPanelProps) {
  return (
    <section
      className="flex flex-col gap-2 rounded-[14px] border border-primary bg-brand-subtle p-5"
      role="status"
      aria-live="polite"
    >
      <p className="inline-flex items-center gap-2 text-[13px] font-semibold text-brand-strong">
        <i className="block h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
        연결됐어요
      </p>
      <h3 className="text-[17px] font-bold tracking-[-0.015em]">{title}</h3>
      <p className="text-[13.5px] leading-relaxed text-muted-foreground">{description}</p>
      {children && <div className="mt-1.5 flex flex-wrap gap-2">{children}</div>}
    </section>
  );
}
