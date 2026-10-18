'use client';

// 「채널에서 들어온 피드백」 — 최근 몇 건을 훑어보는 요약이다. 답장은 대화 탭(/inbox)에서 한다.
// 예전 KakaoChat 은 카카오 말풍선 모양을 흉내 냈는데, 지금 기본 채널은 웹 위젯이라 채널 중립적인
// 목록으로 바꿨다. v4: 목록을 카드 하나에 담고 행 사이는 헤어라인만 둔다.

import Link from 'next/link';
import { SectionTitle } from '@/components/layout/SectionTitle';
import { ChevronRight, CornerDownLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { sourceLabel } from '@/lib/channel/labels';

export interface FeedbackItem {
  id: string;
  userName: string;
  content: string;
  source: string;
  createdAt: string;
  botResponse?: string | null;
  pr?: { url: string; number: number } | null;
  returnedAt?: string | null;
  returnQueuedAt?: string | null;
}

interface RecentFeedbackProps {
  feedbacks: FeedbackItem[];
  limit?: number;
}

const timeFormatter = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' });
const dateFormatter = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric' });

function formatWhen(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? timeFormatter.format(d) : dateFormatter.format(d);
}

/**
 * 채널 칩 — 카카오만 노란 바탕, 나머지는 중립.
 *
 * 채널톡을 중립 칩으로 두는 건 취향이 아니다. 카카오 노랑은 「선톡이 안 되는 채널」이라는
 * 제약을 눈에 띄게 하려고 쓴 색이고, 채널톡에는 그 제약이 없다.
 *
 * 라벨 자체는 공용 맵이 정한다 — 입구가 늘 때 고칠 자리를 한 곳으로 모았다.
 */
export function ChannelChip({ source, className }: { source: string; className?: string }) {
  const isKakao = source === 'kakao';
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[12.5px] font-semibold leading-[1.45]',
        isKakao ? 'bg-[#FEE500] text-[#191d1b]' : 'bg-muted text-foreground',
        className,
      )}
    >
      {sourceLabel(source)}
    </span>
  );
}

export function RecentFeedback({ feedbacks, limit = 6 }: RecentFeedbackProps) {
  const shown = feedbacks.slice(0, limit);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <SectionTitle>채널에서 들어온 피드백</SectionTitle>
        <Link href="/inbox" className="inline-flex items-center gap-0.5 text-sm font-semibold text-brand-strong">
          대화에서 답장
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>

      {shown.length === 0 ? (
        <div className="card-surface p-5 sm:p-6">
          <p className="text-sm leading-relaxed text-muted-foreground">
            아직 들어온 피드백이 없습니다. 채널을 연결하면 여기에 쌓입니다.
          </p>
        </div>
      ) : (
        <ul className="card-surface divide-y divide-border px-5 py-1 sm:px-6 sm:py-2">
          {shown.map((f) => (
            <li key={f.id} className="grid grid-cols-[36px_minmax(0,1fr)] gap-3 py-4">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
                {f.userName.slice(0, 1)}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold">{f.userName}</span>
                  <ChannelChip source={f.source} />
                  <span className="ml-auto shrink-0 text-[12.5px] leading-[1.45] text-faint tabular-nums">
                    {formatWhen(f.createdAt)}
                  </span>
                </div>
                <p className="mt-1 text-sm leading-relaxed">{f.content}</p>
                <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12.5px] leading-[1.45] text-faint">
                  <span>{f.botResponse ? 'AI 답변 보냄' : '답변 대기'}</span>
                  {f.pr && (
                    <>
                      <span>·</span>
                      <a href={f.pr.url} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">
                        PR #{f.pr.number}
                      </a>
                    </>
                  )}
                  {(f.returnedAt || f.returnQueuedAt) && (
                    <>
                      <span>·</span>
                      <span className="inline-flex items-center gap-1 font-semibold text-brand-strong">
                        <CornerDownLeft className="h-3 w-3" aria-hidden />
                        {f.returnedAt ? '반영 알림 보냄' : '반영 알림 대기'}
                      </span>
                    </>
                  )}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
