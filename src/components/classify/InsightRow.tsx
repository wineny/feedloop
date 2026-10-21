'use client';

// 피드백 한 건 — v4(2026-09-17) 카드 안의 한 행. 부모(`ClassificationTabs`)가 `.card-surface` 와
// `divide-y` 를 쥐고 있고, 이 행은 패딩과 내용만 안다. 행마다 카드를 따로 주지 않는다 —
// 그게 「SaaS 카드 키트」다. 칩 + 요약 / 인용선 원문 / 메타 한 줄, 우측은 이 건이 루프의
// 어디까지 갔는지: 묶음 → PR → 머지.
//
// ⚠️ 여기엔 「PR 만들기」가 없다(I-10, 2026-09-16). 예전엔 조각 인사이트마다 버튼이 떠서
// 같은 버그에 PR 이 여러 개 열렸다. 묶기는 이제 자동이고(제보 뒤 약 1~2분), PR 은 대시보드
// 「피드백 묶음」에서만 만든다 — 랜딩이 말하는 「사람이 하는 일 = 묶음 확인·반영 승인」 그대로.

import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { Check, ChevronRight, MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useChannelLabels } from '@/lib/channel/useChannelLabels';
import type { GroupRef, Insight } from './types';
import { isGroupable } from '@/lib/classify/taxonomy';
import { PickedShot } from '@/components/picked/PickedShot';
import { dynamicT } from '@/i18n/dynamic';

interface InsightRowProps {
  insight: Insight;
  group: GroupRef | null;
  demo?: boolean;
}

function Sep() {
  return <span className="text-border-strong" aria-hidden>·</span>;
}

/**
 * 카테고리 배지 — 색은 «둘»뿐이다. 코드 수정 대상(버그·UX·기능 요청 = `isGroupable`)은 잉크 채움,
 * 나머지(문의·칭찬·기타)는 회색 바탕에 진한 글자. 다섯 가지 색을 주면 범례가 필요해지고,
 * 범례가 필요한 배지는 이미 실패한 배지다. 회색 알약 하나로 통일했던 v2 는 반대로 너무 조용해서
 * 「이 건이 코드로 이어지나」가 한눈에 안 갈렸다.
 */
function CategoryBadge({ category }: { category: string }) {
  const t = useTranslations('dashboard.groups.categories');
  const code = isGroupable(category);
  return (
    <span
      className={cn(
        'inline-flex min-h-5 shrink-0 items-center rounded-full px-2 text-[12.5px] font-semibold',
        code ? 'bg-foreground text-background' : 'bg-muted text-foreground',
      )}
    >
      {dynamicT(t).has(category) ? dynamicT(t)(category) : category}
    </span>
  );
}

/** 상태 배지(묶음·PR·확인 필요) — 회색의 두 번째 단계. 카테고리보다 한 톤 물러난다. */
function NeutralBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex min-h-5 items-center rounded-full bg-muted px-2 text-[12.5px] font-medium text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * 분류 출처 — 카테고리 배지에 딸린 메타라 배지가 아니라 회색 글자로 둔다. 출처를 모르면(예전 행) 그리지 않는다.
 */
function ClassifiedBy({ by, confidence }: { by: Insight['classified_by']; confidence: Insight['classify_confidence'] }) {
  const t = useTranslations('classify.row');
  if (by === 'jev') {
    return (
      <span
        className="shrink-0 text-[12.5px] font-medium text-faint tabular-nums"
        title={t('jevTitle')}
      >
        Jev{confidence != null && ` ${confidence.toFixed(2)}`}
      </span>
    );
  }
  if (by === 'llm') {
    return (
      <span className="shrink-0 text-[12.5px] font-medium text-faint" title={t('llmTitle')}>
        LLM
      </span>
    );
  }
  return null;
}

export function InsightRow({ insight, group, demo = false }: InsightRowProps) {
  const t = useTranslations('classify.row');
  const format = useFormatter();
  const { sourceLabel, personLabel } = useChannelLabels();
  const msg = insight.messages;
  const source = msg?.source ? sourceLabel(msg.source) : null;
  const sentiment = insight.sentiment ? (dynamicT(t).has(`sentiment.${insight.sentiment}`) ? dynamicT(t)(`sentiment.${insight.sentiment}`) : insight.sentiment) : null;
  const whenAt = new Date(msg?.detected_at || insight.created_at);
  const when = Number.isNaN(whenAt.getTime())
    ? ''
    : whenAt.toDateString() === new Date().toDateString()
      ? format.dateTime(whenAt, { hour: 'numeric', minute: '2-digit' })
      : format.dateTime(whenAt, { month: 'long', day: 'numeric' });
  const pr = group?.pr ?? null;

  return (
    // I-33 — 390px 에서 2열 그리드의 오른쪽 열(묶음 링크 260px)이 폭을 다 가져가 제목이 한 글자씩 세로로
    // 떨어졌다. sm 미만은 1열로 쌓고 배지·링크는 가로로 흘린다. 오른쪽 열의 min-w-0 · 링크의 max-w-full 은
    // 전 구간 적용이다 — auto 트랙의 자동 최소 크기를 풀어야 오른쪽 열이 폭을 독점하지 않는다(원래 있던
    // shrink-0 은 grid 자식이라 아무 일도 안 했다). 640 이상에서도 폭이 모자라면 묶음 링크가 먼저 잘린다.
    // 행 사이 선은 부모 ul 의 divide-y 가 긋는다 — 여기서 border-t 를 또 긋지 않는다.
    <li
      className={cn(
        'grid grid-cols-1 items-start gap-3 px-5 py-4 sm:gap-4 sm:px-6',
        // 짚은 요소가 있는 행만 왼쪽 썸네일 열(96×72)이 생긴다(I-55). 없는 행은 종전 2열 그대로
        insight.picked ? 'sm:grid-cols-[96px_minmax(0,1fr)_auto]' : 'sm:grid-cols-[minmax(0,1fr)_auto]',
      )}
    >
      {insight.picked && <PickedShot data={insight.picked} size="row" />}
      <div className="flex min-w-0 flex-col gap-2">
        {/* 요약이 길면 배지 옆에서 다음 줄로 흘러야 한다 — items-center 한 줄 고정이면 좁은 폭에서 배지가 찌그러진다 */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <CategoryBadge category={insight.category} />
          <ClassifiedBy by={insight.classified_by} confidence={insight.classify_confidence} />
          {/* I-05 — 꼬리질문 답이 기존 인사이트 갱신으로 흡수됐을 때만 뜬다. */}
          {insight.source_message_ids && insight.source_message_ids.length > 0 && (
            <NeutralBadge>{t('followUpTurns', { count: insight.source_message_ids.length })}</NeutralBadge>
          )}
          <p className="min-w-0 text-[15px] font-semibold leading-[1.3] tracking-[-0.01em]">{insight.summary}</p>
        </div>

        {msg && (
          <p className="border-l-2 border-border-strong pl-3 text-sm leading-relaxed">{msg.body}</p>
        )}

        <p className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-faint tabular-nums">
          {msg && <span>{msg.author_name ?? personLabel(msg.source ?? '')}</span>}
          {source && (
            <>
              <Sep />
              <span>{source}</span>
            </>
          )}
          <Sep />
          <span>{when}</span>
          {insight.picked && (
            <>
              <Sep />
              <span className="inline-flex min-w-0 items-center gap-0.5 text-brand-strong" title={insight.picked.selector}>
                <MapPin className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{insight.picked.label}</span>
              </span>
            </>
          )}
          {sentiment && (
            <>
              <Sep />
              <span>{sentiment}</span>
            </>
          )}
        </p>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 sm:shrink-0 sm:flex-col sm:flex-nowrap sm:items-end sm:gap-1.5">
        {pr ? (
          <>
            {pr.mergedAt ? (
              <span className="inline-flex min-h-5 items-center gap-1 rounded-full bg-brand-subtle px-2 text-[12.5px] font-medium text-brand-strong">
                <Check className="h-3 w-3" aria-hidden />
                {t('prShipped', { number: pr.number })}
              </span>
            ) : (
              <NeutralBadge>{t('prOpen', { number: pr.number })}</NeutralBadge>
            )}
          </>
        ) : group ? (
          <NeutralBadge>{t('groupSize', { count: group.insightCount })}</NeutralBadge>
        ) : insight.group_id ? (
          // 묶였는데 목록(/api/groups)에 없다 = 운영자가 닫은(dismissed) 묶음이다. 「곧 묶여요」라고
          // 하면 거짓이다 — 자동 묶기는 group_id 가 NULL 인 것만 본다.
          <NeutralBadge>{t('groupClosed')}</NeutralBadge>
        ) : isGroupable(insight.category) ? (
          // 자동 묶기(I-10)가 곧 잡는다. 「아직 안 묶임」은 사람이 눌러야 하는 것처럼 읽혔다.
          // 데모(로그아웃 심사 화면)의 예시 행은 영원히 안 묶이므로 그 약속을 하지 않는다.
          <NeutralBadge>{demo ? t('notGroupedYet') : t('groupingSoon')}</NeutralBadge>
        ) : (
          // 「아직」은 곧 해소될 대기 상태로 읽힌다. cs·praise·other 는 묶기 대상이
          // 아니라 **영원히 안 묶인다** — 끝난 상태로 보이게 문구를 가른다.
          <NeutralBadge>{t('notGroupable')}</NeutralBadge>
        )}

        {insight.follow_up_needed && <NeutralBadge>{t('needsPerson')}</NeutralBadge>}

        {group && (
          <Link
            href="/dashboard"
            className="inline-flex min-w-0 max-w-full items-center gap-0.5 text-[12.5px] font-semibold text-brand-strong hover:underline sm:max-w-[260px]"
          >
            <span className="truncate">{t('groupLink', { title: group.title })}</span>
            <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
          </Link>
        )}

        {!pr && (
          <Link
            href="/inbox"
            className={cn('inline-flex items-center gap-0.5 text-[12.5px] font-medium text-faint hover:text-foreground')}
          >
            {t('viewConversation')}
            <ChevronRight className="h-3 w-3" aria-hidden />
          </Link>
        )}
      </div>
    </li>
  );
}
