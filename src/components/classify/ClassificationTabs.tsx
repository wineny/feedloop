'use client';

// 카테고리 탭 + 목록 — v4(2026-09-17). 탭과 행을 `.card-surface` 하나에 담는다. 행 사이는 divide-y,
// 행마다 카드를 따로 주지 않는다. 탭은 밑줄 탭(14/600, 활성 = 잉크 밑줄 2px) 그대로 — 알약·배경칠 없음.
// 색으로 카테고리를 구분하던 점 6색은 뺐다 — 라벨 텍스트가 이미 말한다.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { InsightRow } from './InsightRow';
import type { GroupRef, Insight } from './types';

interface ClassificationTabsProps {
  insights: Insight[];
  /** group_id → 묶음 요약. 데모 모드처럼 없으면 빈 맵 */
  groupsById: Map<string, GroupRef>;
  demo?: boolean;
}

// 탭 이름은 `dashboard.groups.categories.*` (묶음 카드의 카테고리 배지와 같은 말). 「전체」만 `classify.tabs.all`.
const CATEGORIES = ['all', 'bug', 'ux', 'feature_request', 'cs', 'praise', 'other'] as const;

type Category = (typeof CATEGORIES)[number];

export function ClassificationTabs({ insights, groupsById, demo = false }: ClassificationTabsProps) {
  const t = useTranslations('classify.tabs');
  const tc = useTranslations('dashboard.groups.categories');
  const [active, setActive] = useState<Category>('all');

  const countOf = (value: Category) =>
    value === 'all' ? insights.length : insights.filter((i) => i.category === value).length;

  const shown = active === 'all' ? insights : insights.filter((i) => i.category === active);

  return (
    <section className="card-surface overflow-hidden" aria-label={t('aria')}>
      {/* I-33 — 탭 7개가 한 줄을 고집하면 390px 에서 본문이 가로로 넘친다. sm 미만은 탭 행만 가로로
          스크롤한다(접으면 활성 탭 밑줄이 컨테이너 선에서 떨어져 떠 보인다). 스크롤바는 숨기고 대신
          오른쪽 끝을 카드색으로 옅게 덮어 「더 있다」를 알린다 — 끝 탭이 반쯤 잘려 보이는 것과 같은 단서를
          두 겹으로 준다. sm 이상은 한 줄에 다 들어가므로 덮개를 뗀다. */}
      <div className="relative after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-10 after:bg-gradient-to-l after:from-card after:to-transparent sm:after:hidden">
        <div
          role="tablist"
          className="scrollbar-hide flex items-end gap-5 overflow-x-auto border-b border-border px-5 sm:overflow-visible sm:px-6"
        >
          {CATEGORIES.map((cat) => {
            const isActive = cat === active;
            return (
              <button
                key={cat}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActive(cat)}
                className={cn(
                  '-mb-px inline-flex min-h-12 items-center gap-1.5 whitespace-nowrap border-b-2 text-sm font-semibold transition-colors',
                  isActive ? 'border-foreground text-foreground' : 'border-transparent text-faint hover:text-muted-foreground',
                )}
              >
                {cat === 'all' ? t('all') : tc(cat)}
                <span className={cn('text-[12.5px] font-medium tabular-nums', isActive ? 'text-muted-foreground' : 'text-faint')}>
                  {countOf(cat)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="flex flex-col items-center gap-3 px-5 py-12 text-center sm:px-6">
          {/* 빈 상태에만 이모지를 쓴다 — 목록 행마다 아이콘을 다는 건 생성형 디자인의 티다 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/emoji/card_index_dividers_3d.png" alt="" aria-hidden width={44} height={44} className="h-11 w-11" />
          <p className="text-sm leading-relaxed text-muted-foreground">{t('empty')}</p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {shown.map((insight) => (
            <InsightRow
              key={insight.id}
              insight={insight}
              group={insight.group_id ? groupsById.get(insight.group_id) ?? null : null}
              demo={demo}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
