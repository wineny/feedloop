'use client';

import { cn } from '@/lib/utils';

export interface LoopEvent {
  id: string;
  kind: 'classified' | 'pr_created' | 'pr_failed' | 'returned';
  title: string;
  detail: string;
  at: string;
}

interface LoopActivityFeedProps {
  events: LoopEvent[];
  /** 사이드 칼럼에 들어가므로 길이를 자른다 */
  limit?: number;
}

// 점 색은 셋뿐이다 — 되돌림(브랜드) · PR(잉크) · 그 외(회색). 종류마다 색을 늘리지 않는다.
const dotByKind: Record<LoopEvent['kind'], string> = {
  returned: 'bg-primary',
  pr_created: 'bg-foreground',
  pr_failed: 'bg-foreground',
  classified: 'bg-border-strong',
};

const labelByKind: Record<LoopEvent['kind'], string> = {
  classified: 'AI 분류',
  pr_created: '수정안 만듦',
  pr_failed: '자동 수정 중단',
  returned: '반영 알림',
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

/** 사이드 칼럼 「루프에서 일어난 일」 — 헤어라인 타임라인 */
export function LoopActivityFeed({ events, limit = 8 }: LoopActivityFeedProps) {
  const shown = events.slice(0, limit);

  return (
    <section className="card-surface flex flex-col gap-2 p-5">
      <h3 className="text-sm font-bold">루프에서 일어난 일</h3>
      {shown.length === 0 ? (
        <p className="py-2 text-sm leading-relaxed text-muted-foreground">
          아직 기록이 없습니다. 피드백이 들어와 분류되면 여기에 쌓입니다.
        </p>
      ) : (
        <ol>
          {shown.map((e) => (
            <li
              key={e.id}
              className="grid grid-cols-[14px_minmax(0,1fr)] gap-2 border-t border-border py-2.5 text-sm leading-[1.45] first:border-t-0"
            >
              <span className={cn('mx-1 mt-[7px] h-1.5 w-1.5 rounded-full', dotByKind[e.kind])} aria-hidden />
              <div className="min-w-0">
                <p className="truncate">
                  <span className="font-medium text-foreground">{labelByKind[e.kind]}</span>
                  <span className="text-muted-foreground"> · {e.title}</span>
                </p>
                <p className="text-[12.5px] text-faint tabular-nums">{timeAgo(e.at)}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
