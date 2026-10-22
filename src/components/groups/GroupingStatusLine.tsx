'use client';

// 자동 묶기 상태 한 줄 (I-10 · I-12) — 「피드백」 탭과 대시보드 「피드백 묶음」이 같이 쓴다.
//
// 묶기는 이제 저절로 된다(제보 뒤 약 1~2분). 이 줄이 하는 일은 «지금 어디쯤인가»를 말하고,
// 기다리기 싫은 사람에게 [지금 묶기]를 주는 것이다. 버튼은 폴백이지 주 경로가 아니다.

import { useEffect, useRef, useState } from 'react';
import { Layers, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { GroupingStatus } from '@/lib/groups/grouping-status';
import { DemoHint } from '@/components/demo/DemoHint';

interface GroupingStatusLineProps {
  status: GroupingStatus | null | undefined;
  /** [지금 묶기]. 부모가 /api/groups/run 을 부르고 다시 읽는다. */
  onRunNow: () => void | Promise<void>;
  running: boolean;
  /** 연습용 화면에서 [지금 묶기]를 짚어 줄 문구. 진짜 운영 화면에서는 넘기지 않는다. */
  hint?: string | null;
  /** 예정·진행 중이면 이 간격으로 부모에게 다시 읽으라고 한다. 기본 10초. */
  onRefresh?: () => void | Promise<void>;
  refreshMs?: number;
}

/**
 * 상태를 사전 키(`dashboard.grouping.<key>`)와 인자로 돌려준다. 순수 함수 — 테스트한다.
 * due 가 지났는데 아직 클레임 전이면 대기하던 함수가 막 깨어나는 찰나다(클레임이 due 를 비운다).
 * 30초 안이면 「곧」으로 두고 계속 다시 읽는다. 그 뒤에도 남아 있으면 그 함수는 죽은 것이다.
 */
export function groupingStatusMessage(
  status: GroupingStatus,
  now = Date.now(),
): { key: 'none' | 'running' | 'due' | 'soon' | 'idle'; vars: { count: number; secs?: number }; waiting: boolean } {
  const count = status.pending;
  if (count === 0) return { key: 'none', vars: { count }, waiting: false };
  if (status.running) return { key: 'running', vars: { count }, waiting: true };
  const dueMs = status.dueAt ? new Date(status.dueAt).getTime() - now : NaN;
  if (Number.isFinite(dueMs) && dueMs > 0) {
    return { key: 'due', vars: { count, secs: Math.max(5, Math.round(dueMs / 5000) * 5) }, waiting: true };
  }
  if (Number.isFinite(dueMs) && dueMs > -30_000) return { key: 'soon', vars: { count }, waiting: true };
  return { key: 'idle', vars: { count }, waiting: false };
}

export function GroupingStatusLine({ status, onRunNow, running, hint = null, onRefresh, refreshMs = 10_000 }: GroupingStatusLineProps) {
  const t = useTranslations('dashboard.grouping');
  const [now, setNow] = useState(() => Date.now());

  // 상태를 못 읽었으면(마이그레이션이 늦은 배포 등) 문장은 없지만 [지금 묶기]는 살아 있어야 한다.
  const msg = status ? groupingStatusMessage(status, now) : null;
  const described = { text: msg ? t(msg.key, msg.vars) : t('unreadable'), waiting: msg?.waiting ?? false };
  const waiting = described.waiting;

  // 「약 N초 뒤」가 멈춘 숫자로 보이지 않게 5초마다 다시 센다 — 기다리는 동안만.
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, [waiting]);

  // 부모의 onRefresh 는 렌더마다 새 함수일 수 있다(대시보드 fetchGroups). 의존성에 넣으면
  // 새로고침 성공 → 부모 재렌더 → effect 재생성 → 횟수 리셋으로 상한이 죽는다(코드 리뷰 M2).
  const refreshRef = useRef(onRefresh);
  useEffect(() => {
    refreshRef.current = onRefresh;
  }, [onRefresh]);

  // 예정·진행 중일 때만 부모를 깨운다. 상한 20회 — 화면을 켜 둔 채 잊어도 폴링이 영원히 돌지 않게.
  useEffect(() => {
    if (!waiting) return;
    let ticks = 0;
    const t = setInterval(() => {
      ticks += 1;
      if (ticks > 20) { clearInterval(t); return; }
      void refreshRef.current?.();
    }, refreshMs);
    return () => clearInterval(t);
  }, [waiting, refreshMs]);

  return (
    // aria-live 는 일부러 없다 — 5초마다 바뀌는 카운트다운을 스크린리더가 계속 읽는다.
    // v4 — 읽으라고 쓴 문장이라 본문 크기(14)다. 12.5 는 메타(시각·건수)에만 쓴다.
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm leading-relaxed text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        {waiting && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
        {described.text}
      </span>
      {(!status || status.pending > 0) && (
        <span className="relative inline-flex">
          {hint && <DemoHint label={hint} placement="right" />}
          <button
            type="button"
            onClick={() => void onRunNow()}
            disabled={running || status?.running === true}
            className="inline-flex items-center gap-1 text-sm font-semibold text-brand-strong disabled:opacity-50"
          >
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Layers className="h-3.5 w-3.5" aria-hidden />}
            {t('runNow')}
          </button>
        </span>
      )}
    </p>
  );
}
