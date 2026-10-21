'use client';

// 「수정 PR」 상세가 GitHub 쪽 정보(diff · 프리뷰 · 빌드)를 읽는 훅 (I-19).
// 빌드가 진행 중이거나 초안 PR 이 자동 검사를 기다리는 중이면 다시 읽어 버튼이 저절로 열리게 한다. 끝난 뒤엔 멈춘다.
// (초안 승격은 서버가 이 GET 을 받을 때 판정한다 — 폴링이 멈추면 승격도 화면에 안 보인다)
//
// 폴링은 공용 GITHUB_TOKEN 의 시간당 예산(5,000회)을 자동 PR 엔진·크론과 나눠 쓴다 — 한 번에
// GitHub 호출 8회라 60초 간격, 배경 탭이면 건너뛰고, 30번(30분) 넘으면 멈추고 「다시 확인」에 맡긴다.

import type { PickedShotData } from '@/lib/widget/picked-shot';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { PrReview } from '@/lib/auto-dev/pr-review';
import type { RunExplanation } from '@/lib/auto-dev/explanation';
import type { PickedTarget } from '@/lib/auto-dev/picked-targets';

export type PrReviewData = Omit<PrReview, 'body'>;

export interface PrReviewResponse {
  review: PrReviewData;
  blockedBy: 'merged' | 'closed' | 'build_failed' | 'build_pending' | 'conflict' | null;
  legacyExplanation: RunExplanation | null;
  /** 제보자가 화면에서 짚은 요소와 그리는 파일(PR 본문에서 파싱). 옛 응답엔 없을 수 있다 */
  pickedTargets?: PickedTarget[];
  /** 근거 제보가 짚은 화면(I-55) — 썸네일 + 테두리 */
  pickedShots?: PickedShotData[];
}

/** 반영 버튼을 잠그는 이유 — 서버 판정(blockedBy)에 초안 대기·수동 초안을 더한 것. 머지 API 도 같은 경우 409 `draft_waiting` */
export type PrBlockReason = NonNullable<PrReviewResponse['blockedBy']> | 'draft_waiting' | 'manual_draft';

/** 자동 쓰기를 건너뛴 이유(서버 `draftGateBlocked`). 옛 응답엔 없다 */
export type DraftGateBlocked = NonNullable<PrReviewData['draftGateBlocked']>;

/** 잠금·GitHub 쓰기·게이트 확인이 잠깐 실패한 것 — 다음 조회에서 다시 시도된다 */
export function isTransientGateBlock(reason: PrReviewData['draftGateBlocked']): boolean {
  return reason === 'lock_unavailable' || reason === 'write_failed' || reason === 'gate_failed';
}

/**
 * 서버 판정이 우선 — 빌드 진행·실패가 더 구체적이다. 옛 응답·데모엔 draftGate 가 없어 초안이 아닌 것으로 본다.
 * 권한 부족(awaiting_human·checks_unavailable)은 잠그지 않는다 — 담당자가 「빌드 확인 없이 반영하기」로 반영한다.
 * 잠깐 실패(isTransientGateBlock)도 그 자체로는 잠그지 않는다 — 아직 초안이면 waiting 이 잠그고, 이미 바뀐 PR 은 반영 요청이 다시 판정한다.
 */
export function effectiveBlock(data: PrReviewResponse | null): PrBlockReason | null {
  if (!data) return null;
  if (data.blockedBy) return data.blockedBy;
  if (data.review.draftGateBlocked === 'manual_draft') return 'manual_draft';
  return data.review.draftGate === 'waiting' ? 'draft_waiting' : null;
}

/**
 * 다시 읽을 이유가 있나 — 빌드·프리뷰 진행 중, 초안이 자동 검사를 기다리는 중, 자동 전환이 잠깐 실패한 중.
 * 수동 초안·권한 부족은 시간이 지나도 저절로 안 바뀌어 읽지 않는다.
 */
export function needsPolling(data: PrReviewResponse | null): boolean {
  if (!data) return false;
  const { build, preview, draftGate, draftGateBlocked } = data.review;
  if (build.state === 'pending' || preview.state === 'building') return true;
  if (isTransientGateBlock(draftGateBlocked)) return true;
  return draftGate === 'waiting' && !draftGateBlocked;
}

export const BUILD_POLL_MS = 60_000;
export const BUILD_POLL_MAX = 30;

export function usePrReview(runId: string | null, enabled: boolean) {
  const [data, setData] = useState<PrReviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pollsLeft, setPollsLeft] = useState(BUILD_POLL_MAX);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 오류 기본 문구. 번역 함수가 렌더마다 바뀌어도 load 가 다시 만들어져 재조회하지 않게 ref 로 든다
  const t = useTranslations('monitor.errors');
  const fallback = useRef(t('prInfo'));
  fallback.current = t('prInfo');

  const load = useCallback(async () => {
    if (!runId || !enabled) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/auto-dev/runs/${runId}/pr`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || fallback.current);
      setData(json as PrReviewResponse);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback.current);
    } finally {
      setLoading(false);
    }
  }, [runId, enabled]);

  // run 이 바뀌면 이전 결과를 비운다 — 다른 PR 의 diff 가 잠깐 보이면 안 된다
  useEffect(() => {
    setData(null);
    setError(null);
    setPollsLeft(BUILD_POLL_MAX);
    load();
  }, [load]);

  const building = needsPolling(data);
  const pollingStopped = building && pollsLeft <= 0;

  useEffect(() => {
    if (!building || pollsLeft <= 0) return;
    let cancelled = false;
    const tick = () => {
      timer.current = setTimeout(() => {
        if (cancelled) return;
        // 배경 탭은 이번 회차를 건너뛴다 — 예산만 태우고 아무도 안 본다. 회차 수도 안 센다
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
          tick();
          return;
        }
        setPollsLeft((n) => n - 1);
        load();
      }, BUILD_POLL_MS);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
    // data 가 바뀔 때마다(=응답이 올 때마다) 다음 회차를 건다
  }, [building, pollsLeft, load, data]);

  const reload = useCallback(() => {
    setPollsLeft(BUILD_POLL_MAX);
    return load();
  }, [load]);

  return { data, error, loading, reload, pollingStopped };
}
