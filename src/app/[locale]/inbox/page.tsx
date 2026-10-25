'use client';

// 대화 — AI 가 1차로 답한 대화를 운영자가 이어받는 곳.
// 웹 위젯과 카카오 대화를 한 화면에서 본다(둘 다 conversations 위에 있다).
// v4(2026-09-17): 목록과 상세를 각각 `.card-surface` 에 담는 2단. 선택 행은 옅은 브랜드 바탕 + 좌측 선,
// 말풍선은 방문자 회색 / AI 테두리 / 운영자 잉크 채움 — 구분은 v2 그대로, radius 만 카드 체계(16)에 맞췄다.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import type { Locale } from '@/i18n/routing';
import { PageHero, PAGE_EMOJI } from '@/components/layout/PageHero';
import { LoadingState, ErrorState } from '@/components/layout/PageState';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ChannelChip } from '@/components/dashboard/RecentFeedback';
import { useChannelLabels } from '@/lib/channel/useChannelLabels';
import { cn } from '@/lib/utils';
import { useDemoMode } from '@/lib/demo/useDemoMode';
import { DemoHint } from '@/components/demo/DemoHint';
import { summarizeContext } from '@/lib/widget/context-summary';
import { pickedFromContext } from '@/lib/widget/picked-shot';
import type { PickedShotView } from '@/lib/widget/pick';
import { PickedShot } from '@/components/picked/PickedShot';
import { useBotScope } from '@/lib/scope/BotScopeProvider';
import { scopedUrl } from '@/lib/scope/scope';
import { ScopeNote } from '@/components/layout/BotScopeSelect';
import { PaymentActionCard, type PaymentDecision } from '@/components/inbox/PaymentActionCard';
import { interpretDecisionResponse, type PaymentActionView } from '@/lib/paypal/action-view';
import { PaymentActivityPanel } from '@/components/inbox/PaymentActivityPanel';
import type { LedgerResponse, LedgerRow } from '@/lib/paypal/ledger';
import Link from 'next/link';
import { Loader2, Clock, CornerDownLeft, UserRound, ExternalLink, ChevronRight } from 'lucide-react';

interface InboxItem {
  id: string;
  source: string;
  externalUserId: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone?: string | null;
  lastMessageAt: string | null;
  lastMessageBody: string | null;
  unread: boolean;
  /** 담당자가 봐야 한다 — AI 가 물러났거나 방문자가 직접 불렀다. 안 읽음(점)과는 다른 축이다 — 읽어도 사라지지 않는다. */
  escalated?: boolean;
  ownerEmailStatus?: string | null;
  ownerEmailError?: string | null;
}

interface TimelineItem {
  id: string;
  kind: 'user' | 'ai' | 'operator' | 'system' | 'notice' | 'payment';
  body: string;
  at: string;
}

interface DemoInbox {
  conversations: InboxItem[];
  timelines: Record<string, TimelineItem[]>;
  /** 연습용 화면에서 사람이 닫은 대화. 다른 대화를 들렀다 돌아와도 닫힌 채로 보이게 한다. */
  closedIds?: string[];
  /** 대화 id → 메시지 id → 제보 맥락. 짚은 요소 카드(I-55)를 데모에서도 보이려고 */
  contexts?: Record<string, Record<string, unknown>>;
  /** 대화 id → 메시지 id → 예시 화면(정적 자산) */
  shots?: Record<string, Record<string, PickedShotView>>;
  /** 대화 id → 승인 카드(버튼은 꺼짐)와 결제 내역 줄. 대시보드 예시 장부와 같은 행이다. */
  payments?: Record<string, { actions: PaymentActionView[]; rows: LedgerRow[] }>;
}

type Filter = 'all' | 'unread';

/** 연락처를 안 남긴 방문자는 식별자 앞 4자로 부른다. 호칭 자체는 공용 맵이 정한다. */
function displayName(c: InboxItem, personLabel: (source: string) => string): string {
  if (c.contactName) return c.contactName;
  return `${personLabel(c.source)} #${c.externalUserId.slice(0, 4)}`;
}

type Translate = ReturnType<typeof useTranslations<'inbox'>>;
type Formatter = ReturnType<typeof useFormatter>;

function timeAgo(value: string | null, t: Translate): string {
  if (!value) return '';
  const diff = Date.now() - new Date(value).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('timeAgo.now');
  if (mins < 60) return t('timeAgo.minutes', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('timeAgo.hours', { count: hours });
  const days = Math.floor(hours / 24);
  return days === 1 ? t('timeAgo.yesterday') : t('timeAgo.days', { count: days });
}

function formatAt(value: string, format: Formatter): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const time = format.dateTime(d, { hour: 'numeric', minute: '2-digit' });
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? time : `${format.dateTime(d, { month: 'long', day: 'numeric' })} ${time}`;
}

const KIND_KEYS = { ai: 'ai', operator: 'operator', system: 'system', notice: 'notice', payment: 'payment' } as const;

/** 위젯이 붙은 사이트. 프로토콜은 떼고 호스트만 보여준다 — 길어서 헤더를 밀어낸다. */
function originLabel(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin.slice(0, 60);
  }
}

/**
 * 「담당자 확인 필요」 — 사람이 이어받아야 하는 대화. 두 경로가 같은 배지로 모인다:
 * AI 가 지식에 없어 물러난 경우(needsEscalation), 방문자가 위젯의 「담당자에게 물어보기」를
 * 누른 경우(escalate 라우트). 버그 제보에도 AI 가 escalate 를 켜곤 하므로 「담당자 확인 필요」이라
 * 부르면 시연에서 「AI 가 답 못 했나?」로 읽힌다 — 배지는 상태(할 일)를 말한다.
 *
 * 안 읽음 점과 다른 축이다. 점은 열면 꺼지지만 이건 «답장을 보내야» 꺼진다.
 * 그래서 같은 자리에 같은 모양으로 두지 않는다.
 */
function EscalatedBadge({ className }: { className?: string }) {
  const t = useTranslations('inbox');
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full bg-brand-subtle px-2 py-0.5 text-[12.5px] font-semibold text-brand-strong',
        className,
      )}
    >
      <UserRound className="h-3 w-3" aria-hidden />
      {t('needsReply')}
    </span>
  );
}

/**
 * 방문자 말풍선 밑의 「제보 시점」 한 줄 — 어느 페이지·어떤 기기에서 났는지, 콘솔 에러가 있었는지,
 * 「화면에서 짚기」로 무엇을 골랐는지. 위젯이 메시지마다 보내던 값인데 여태 자동 PR 엔진만 읽고
 * 운영자는 못 봤다(셀프 QA [3]). 셀렉터는 title 로 — 화면엔 방문자가 알아볼 이름만.
 */
function ContextLine({ context, shot, at }: { context: unknown; shot?: PickedShotView; at?: string }) {
  const t = useTranslations('inbox.context');
  const locale = useLocale() as Locale;
  const s = summarizeContext(context, locale);
  const picked = pickedFromContext(context, shot, at, locale);
  if (!s) return null;
  const facts = [
    s.page,
    s.viewport,
    s.browser,
    s.errors ? t('errors', { count: s.errors }) : null,
    s.requests ? t('requests', { count: s.requests }) : null,
  ].filter((v): v is string => !!v);
  return (
    <div className="flex flex-col gap-0.5 text-[12.5px] text-faint">
      {facts.length > 0 && (
        <span className="truncate" title={facts.join(' · ')}>
          {t('prefix', { facts: facts.join(' · ') })}
        </span>
      )}
      {/* 짚은 요소 — 찍은 화면 + 테두리(I-55). 이미지가 없으면 같은 좌표로 미니맵 */}
      {picked && <PickedShot data={picked} className="mt-1" />}
    </div>
  );
}

/** 타임라인 말풍선 — 유저는 왼쪽 회색, AI 는 오른쪽 테두리, 운영자는 오른쪽 잉크 채움. radius 16 = 카드와 같은 체계 */
function Bubble({ item, userLabel, context, shot }: { item: TimelineItem; userLabel: string; context?: unknown; shot?: PickedShotView }) {
  const t = useTranslations('inbox');
  const format = useFormatter();
  if (item.kind === 'system') {
    return (
      <div className="self-center">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-subtle px-3 py-1.5 text-[12.5px] font-semibold text-brand-strong">
          <CornerDownLeft className="h-3 w-3" aria-hidden />
          {item.body}
        </span>
      </div>
    );
  }

  // 결제 카드(3단계) — 서버 고정 영어 문장(환불 결과·결제 링크). 링크 줄은 운영자에겐 텍스트로만 보인다.
  if (item.kind === 'payment') {
    return (
      <div className="self-end max-w-[72%]">
        <div className="rounded-[16px] rounded-br-[4px] border border-border bg-muted/40 px-4 py-3 text-sm leading-relaxed">
          <span className="mb-1 block text-[12.5px] font-semibold text-muted-foreground">{t('kind.payment')} · {formatAt(item.at, format)}</span>
          <span className="whitespace-pre-wrap break-words">{item.body}</span>
        </div>
      </div>
    );
  }

  // 가운데 안내 칩 — 방문자가 「담당자에게 물어보기」를 누른 기록. 되돌림(system)과 달리 강조하지 않는다.
  if (item.kind === 'notice') {
    return (
      <div className="self-center">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-[12.5px] text-muted-foreground">
          <UserRound className="h-3 w-3" aria-hidden />
          {item.body}
        </span>
      </div>
    );
  }

  const mine = item.kind !== 'user';
  const who = mine ? t(`kind.${KIND_KEYS[item.kind as keyof typeof KIND_KEYS]}`) : userLabel;

  return (
    <div className={cn('flex max-w-[72%] flex-col gap-1', mine && 'self-end items-end')}>
      <span className="text-[12.5px] text-faint">
        {who} · {formatAt(item.at, format)}
      </span>
      <div
        className={cn(
          'whitespace-pre-wrap rounded-[16px] px-4 py-3 text-sm leading-relaxed',
          item.kind === 'user' && 'rounded-bl-[4px] bg-muted',
          item.kind === 'ai' && 'rounded-br-[4px] border border-border',
          item.kind === 'operator' && 'rounded-br-[4px] bg-foreground text-background',
        )}
      >
        {item.body}
      </div>
      {item.kind === 'user' && context !== undefined && <ContextLine context={context} shot={shot} at={item.at} />}
    </div>
  );
}

export default function InboxPage() {
  const t = useTranslations('inbox');
  const { personLabel } = useChannelLabels();
  const { status: authStatus } = useSession();
  const demo = useDemoMode<DemoInbox>('inbox');
  // 연습용 안내를 언제 끌지 — 한 번 답장해 보면 「어디에 쓰는지」는 이미 안 것이다.
  const [demoReplied, setDemoReplied] = useState(false);

  const [conversations, setConversations] = useState<InboxItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  // 메시지 id → 제보 맥락(페이지·기기·짚은 요소). 운영자 라우트만 준다 — 무인증 GET 에는 없다.
  const [contexts, setContexts] = useState<Record<string, unknown>>({});
  // 메시지 id → 짚는 순간 찍은 화면의 10분 서명 URL(I-55). 운영자 라우트만 준다
  const [shots, setShots] = useState<Record<string, PickedShotView>>({});
  // 이 대화가 «어느 사이트에서» 왔는지(계획 §B-7). 차단은 하지 않고 보여주기만 한다 —
  // 남의 사이트가 우리 botId 를 심어 운영자 키를 태우는 걸 사후에 알아채는 유일한 단서다.
  const [origin, setOrigin] = useState<string | null>(null);
  // 채널톡 대화를 여는 데스크 주소. 여기서는 답장을 받지 않고 그쪽으로 보낸다.
  const [deskUrl, setDeskUrl] = useState<string | null>(null);
  // 열림/닫힘. 채널톡의 「닫힘」 웹훅 스코프가 확인되지 않아(§3-(f)) 운영자가 직접 닫는 길이
  // 유일한 대안이다 — 그 대안이 화면에 없으면 라우트가 있어도 아무도 못 쓴다.
  const [convStatus, setConvStatus] = useState<string>('open');
  // 결제 행(환불 요청 → 승인 카드, 3단계). 운영자 라우트만 준다; 연습용 화면엔 없다.
  const [paymentActions, setPaymentActions] = useState<PaymentActionView[]>([]);
  // 이 대화의 결제 내역(5단계 6번) — 장부 라우트를 대화로 거른 것. 읽기 전용. 못 읽으면 칸을 숨긴다.
  const [paymentRows, setPaymentRows] = useState<LedgerRow[]>([]);
  // 늦게 온 응답이 다른 대화의 칸을 덮지 않게, 지금 열린 대화 id 를 들고 있는다.
  const openedRef = useRef<string | null>(null);
  // 같은 대화를 두 번 읽을 때(승인 뒤 다시 읽기) 먼저 보낸 요청의 늦은 응답이 새 응답을 덮지 않게 한다.
  const paymentRowsSeq = useRef(0);
  // 이 봇에서 내가 소유자인지 승인자인지(3단계 6/6). 승인자는 환불 카드만 누를 수 있다 —
  // 답장 칸과 「대화 닫기」는 숨긴다(라우트도 403 으로 거절하지만, 안 되는 버튼을 보여 주지 않는다).
  const [role, setRole] = useState<'owner' | 'approver'>('owner');
  const [closing, setClosing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  // 헤더 셀렉터의 서비스 스코프(I-27). 바뀌면 목록을 다시 읽고, 열려 있던 대화가 새 목록에 없으면 닫는다.
  const scope = useBotScope();
  const botId = scope.botId;

  const fetchList = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch(scopedUrl('/api/inbox', botId));
      if (res.status === 401) {
        setConversations([]);
        return;
      }
      if (!res.ok) throw new Error(t('errors.api', { status: res.status }));
      const json = await res.json();
      const list: InboxItem[] = json.conversations ?? [];
      setConversations(list);
      // 다른 서비스로 스코프를 옮기면 이전 대화는 목록에 없다 — 선택을 풀어 첫 대화가 열리게 한다.
      setSelected((prev) => (prev && list.some((c) => c.id === prev) ? prev : null));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.loadList'));
    } finally {
      setLoading(false);
    }
  }, [botId, t]);

  // 스코프가 바뀌면 옛 목록을 새 스코프 이름 밑에 두지 않는다
  useEffect(() => {
    if (!demo.isDemo) setLoading(true);
  }, [botId, demo.isDemo]);

  useEffect(() => {
    if (demo.isDemo) {
      setLoading(false);
      return;
    }
    if (authStatus === 'authenticated') {
      if (scope.ready) void fetchList();
    } else if (authStatus === 'unauthenticated') setLoading(false);
  }, [authStatus, demo.isDemo, scope.ready, fetchList]);

  // 목록이 처음 오면 첫 대화를 연다 — 오른쪽이 「선택하세요」로 비어 있지 않게.
  // 읽음 처리는 실제로 여는 것과 같으므로, 실데이터에서도 첫 대화는 열린 것으로 친다.
  // `?c=<대화 id>` 는 상담원 연결 알림 메일의 「대화에서 답장하기」 버튼이 붙여 보낸다.
  // 목록에 있으면 그 대화를, 아니면(다른 봇·삭제됨) 첫 대화를 연다. useSearchParams 는 정적 프리렌더에서
  // Suspense 경계를 요구하므로 window 에서 한 번만 읽는다.
  const list0 = demo.isDemo ? demo.data.conversations : conversations;
  const firstId = list0[0]?.id ?? null;
  // 딥링크는 «한 번만» 소비한다. URL 에 남아 있는 `?c=` 를 매번 다시 읽으면, 아래에서 스코프를 전체로
  // 넓힌 뒤 운영자가 다른 서비스를 고를 때마다 또 전체로 되돌리는 루프가 생긴다.
  const deepLinkRef = useRef<string | null | undefined>(undefined);
  // 전체에서도 못 찾아 포기한 뒤에는 목록이 다시 와도 첫 대화를 «조용히» 열지 않는다 — 운영자가 고른다.
  const deepLinkGaveUp = useRef(false);
  useEffect(() => {
    if (selected || deepLinkGaveUp.current) return;
    // 목록을 아직 읽는 중이면 판단하지 않는다 — 빈 목록을 「없다」로 읽으면 안 된다
    if (!demo.isDemo && loading) return;
    if (deepLinkRef.current === undefined) {
      try {
        deepLinkRef.current = new URLSearchParams(window.location.search).get('c');
      } catch {
        deepLinkRef.current = null;
      }
    }
    const wanted = deepLinkRef.current;
    // 딥링크가 없으면 첫 대화를 연다. 목록이 비었으면 열 것이 없다.
    if (!wanted && !firstId) return;
    if (wanted && !list0.some((c) => c.id === wanted)) {
      // 헤더 스코프(I-27)가 다른 서비스를 보고 있어 가려진 것일 수 있다 — 전체로 넓혀 한 번 더 찾는다.
      // 목록이 다시 오면 이 이펙트가 다시 돈다(list0 가 바뀐다).
      if (botId) {
        scope.setBotId(null);
        return;
      }
      // 전체에서도 없으면 첫 대화로 조용히 흘리지 않는다 — 운영자가 엉뚱한 방문자에게 답장할 수 있다
      deepLinkRef.current = null;
      deepLinkGaveUp.current = true;
      setNotice(t('notices.deepLinkMissing'));
      return;
    }
    deepLinkRef.current = null;
    handleOpenConversation(wanted ?? firstId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstId, selected, list0, botId, loading, demo.isDemo]);

  const loadPaymentRows = async (id: string) => {
    const seq = ++paymentRowsSeq.current;
    const current = () => openedRef.current === id && paymentRowsSeq.current === seq;
    try {
      const res = await fetch(`/api/payments/ledger?conversationId=${encodeURIComponent(id)}`);
      const json = res.ok ? ((await res.json()) as LedgerResponse) : null;
      if (current()) setPaymentRows(json?.rows ?? []);
    } catch {
      if (current()) setPaymentRows([]);
    }
  };

  const handleOpenConversation = async (id: string) => {
    setSelected(id);
    setNotice(null);
    if (openedRef.current !== id) setPaymentRows([]);
    openedRef.current = id;

    if (demo.isDemo) {
      setTimeline(demo.data.timelines[id] ?? []);
      setContexts(demo.data.contexts?.[id] ?? {});
      setShots(demo.data.shots?.[id] ?? {});
      setOrigin(null);
      setDeskUrl(null);
      setPaymentActions(demo.data.payments?.[id]?.actions ?? []);
      setPaymentRows(demo.data.payments?.[id]?.rows ?? []);
      setRole('owner');
      // 닫아 둔 대화는 닫힌 채로 다시 연다 — 늘 'open' 으로 되돌리면 [대화 닫기]가 안 먹은 것처럼 보인다.
      setConvStatus(demo.data.closedIds?.includes(id) ? 'closed' : 'open');
      return;
    }

    void loadPaymentRows(id);
    try {
      const res = await fetch(`/api/inbox/${id}`);
      if (!res.ok) throw new Error(t('errors.api', { status: res.status }));
      const json = await res.json();
      // 열었으니 읽음 — 목록의 점을 즉시 끈다(서버는 이미 기록했다)
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, unread: false } : c)));
      // 그 사이 다른 대화를 열었으면 이 응답으로 화면을 덮지 않는다
      if (openedRef.current !== id) return;
      setTimeline(json.items ?? []);
      setContexts(json.contexts && typeof json.contexts === 'object' ? json.contexts : {});
      setShots(json.shots && typeof json.shots === 'object' ? json.shots : {});
      setOrigin(json.conversation?.origin ?? null);
      setDeskUrl(json.conversation?.deskUrl ?? null);
      setConvStatus(json.conversation?.status ?? 'open');
      setPaymentActions(Array.isArray(json.paymentActions) ? json.paymentActions : []);
      setRole(json.role === 'approver' ? 'approver' : 'owner');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.open'));
    }
  };

  // 되돌리기가 없다. 그래서 브라우저 confirm 을 띄우는 대신 버튼 옆에 그 사실을 적어 둔다 —
  // confirm 은 읽히지 않고 눌리기만 하는데, 여기서 필요한 건 «누르기 전에 아는 것»이다.
  const handleCloseConversation = async () => {
    if (!selected || closing) return;

    // 연습용 화면(로그아웃) — 이 탭 안에서만 닫힌다. 서버로는 아무것도 안 나간다.
    if (demo.isDemo) {
      const id = selected;
      demo.patch((prev) => ({
        ...prev,
        closedIds: [...(prev.closedIds ?? []), id],
      }));
      setConvStatus('closed');
      setNotice(t('notices.demoClosed'));
      return;
    }

    setClosing(true);
    setError(null);
    try {
      const res = await fetch(`/api/inbox/${selected}/close`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t('errors.close'));

      setConvStatus('closed');
      setNotice(t('notices.closed'));
      await fetchList();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.close'));
    } finally {
      setClosing(false);
    }
  };

  /**
   * 승인·거절(3단계). 서버가 한 번만 전이시키고(0행이면 409 + 지금 상태) 승인이면 PayPal 로 보낸다.
   * 돌아온 행으로 카드를 갱신한다. 어느 쪽이든 사람이 움직였으니 배지는 서버가 내린다 — 목록도 맞춘다.
   */
  const handleDecidePayment = async (actionId: string, decision: PaymentDecision): Promise<PaymentActionView> => {
    if (!selected) throw new Error(t('errors.noConversation'));
    const res = await fetch(`/api/inbox/${selected}/payment-actions/${actionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    const json = await res.json().catch(() => ({}));
    // Whatever the status, a row in the body is the row as the server now has it — the card shows it.
    // The badge comes down only when the server says so (another refund may still be waiting).
    const effect = interpretDecisionResponse(res.status, json);
    if (effect.action) {
      const next = effect.action;
      setPaymentActions((prev) => prev.map((a) => (a.id === actionId ? next : a)));
    }
    // 결제 내역 칸도 서버 기준으로 다시 — 누가 결정했는지·PayPal 결과까지.
    void loadPaymentRows(selected);
    if (effect.escalationCleared) {
      setConversations((prev) => prev.map((c) => (c.id === selected ? { ...c, escalated: false } : c)));
    }
    // 서버가 문구를 준 경우(effect.notice 가 server error)는 그대로, lib 의 영어 기본 문구는 사전으로 바꾼다.
    if (effect.notice) setNotice(effect.noticeIsFallback ? t('errors.notCompleted', { status: res.status }) : effect.notice);
    if (effect.cardError || !effect.action) {
      const message =
        effect.cardErrorCode === 'alreadyDecided'
          ? t('errors.alreadyDecided')
          : effect.cardErrorCode === 'failed'
            ? t('errors.decisionFailed', { status: res.status })
            : effect.cardError;
      throw new Error(message ?? t('errors.decisionFailed', { status: res.status }));
    }
    return effect.action;
  };

  const handleSendReply = async () => {
    const text = reply.trim();
    if (!text || !selected || sending) return;

    // 연습용 화면(로그아웃) — 답장이 대화에 붙어 보이지만 방문자에게는 가지 않는다.
    // 「사람이 답한다」가 루프의 한 칸이라, 심사자가 그 칸을 직접 눌러 보게 한다.
    if (demo.isDemo) {
      const at = new Date().toISOString();
      const id = selected;
      const entry: TimelineItem = { id: `demo-reply-${Date.now()}`, kind: 'operator', body: text, at };
      demo.patch((prev) => ({
        // `...prev` 를 빼지 말 것 — 닫아 둔 대화 목록처럼 여기서 안 건드리는 값이 조용히 사라진다.
        ...prev,
        conversations: prev.conversations.map((c) =>
          c.id === id ? { ...c, escalated: false, unread: false, lastMessageAt: at, lastMessageBody: text } : c,
        ),
        timelines: { ...prev.timelines, [id]: [...(prev.timelines[id] ?? []), entry] },
      }));
      setTimeline((prev) => [...prev, entry]);
      setReply('');
      setDemoReplied(true);
      setNotice(t('notices.demoReplied'));
      return;
    }

    setSending(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/inbox/${selected}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t('errors.reply'));

      setReply('');
      setNotice(json.notice);
      // 사람이 답했으니 「담당자 확인 필요」은 해소다(서버도 같이 지웠다).
      // 목록을 다시 안 부르고 그 자리에서 끈다 — 배지가 남아 있으면 또 답해야 할 것처럼 보인다.
      setConversations((prev) =>
        prev.map((c) => (c.id === selected ? { ...c, escalated: false } : c)),
      );
      await handleOpenConversation(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.reply'));
    } finally {
      setSending(false);
    }
  };

  const list = demo.isDemo ? demo.data.conversations : conversations;
  const unreadCount = list.filter((c) => c.unread).length;
  const escalatedCount = list.filter((c) => c.escalated).length;
  const shown = filter === 'unread' ? list.filter((c) => c.unread) : list;
  const current = list.find((c) => c.id === selected) ?? null;

  if (authStatus === 'loading' || loading) return <LoadingState />;
  if (error && list.length === 0) {
    return <ErrorState message={error} onRetry={() => { setLoading(true); fetchList(); }} />;
  }

  const tabs: { key: Filter; label: string; count: number }[] = [
    { key: 'all', label: t('tabAll'), count: list.length },
    { key: 'unread', label: t('tabUnread'), count: unreadCount },
  ];

  // 부제 한 줄(v4 §5) — 우선순위는 「담당자 확인 필요」 > 「안 읽음」. 둘 다 0이면 새 대화가 없다는 사실만.
  const subtitle =
    escalatedCount === 0 && unreadCount === 0 ? (
      t('noNew')
    ) : (
      <>
        {escalatedCount > 0 &&
          t.rich('subtitleEscalated', {
            count: escalatedCount,
            strong: (chunks) => <strong className="tabular-nums text-brand-strong">{chunks}</strong>,
          })}
        {escalatedCount > 0 && unreadCount > 0 && ' · '}
        {unreadCount > 0 &&
          t.rich('subtitleUnread', {
            count: unreadCount,
            strong: (chunks) => <strong className="tabular-nums">{chunks}</strong>,
          })}
      </>
    );

  return (
    <div className="flex flex-col gap-10 sm:gap-12">
      <PageHero
        emoji={PAGE_EMOJI.inbox}
        title={t('title')}
        description={
          <>
            <ScopeNote />
            {subtitle}
          </>
        }
      />

      {list.length === 0 ? (
        // 대화가 하나도 없으면 빈 목록 카드 + 「선택하세요」 카드 두 개를 나란히 세우지 않는다 —
        // 빈 상자 둘은 실패 화면처럼 읽힌다. 딥링크 안내(notice)는 여기서도 보여야 한다.
        <div className="card-surface flex flex-col items-center gap-3 px-5 py-14 text-center sm:px-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/emoji/speech_balloon_3d.png" alt="" aria-hidden width={48} height={48} className="h-12 w-12" />
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t('empty')}
          </p>
          {notice && <p className="text-[12.5px] text-brand-strong">{notice}</p>}
          <Link href="/bots" className="inline-flex items-center gap-0.5 text-sm font-semibold text-brand-strong hover:underline">
            {t('addWidget')}
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>
      ) : (
      <div className="grid items-start gap-6 lg:grid-cols-[340px_minmax(0,1fr)] lg:gap-8">
        {/* 대화 목록 카드 — 밑줄 탭 + divide-y 행 */}
        <section className="card-surface min-w-0 overflow-hidden" aria-label={t('listLabel')}>
          <div className="flex items-end gap-5 border-b border-border px-5 sm:px-6" role="tablist">
            {tabs.map((tab) => {
              const on = filter === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setFilter(tab.key)}
                  className={cn(
                    '-mb-px inline-flex min-h-12 items-center gap-1.5 whitespace-nowrap border-b-2 text-sm font-semibold transition-colors',
                    on ? 'border-foreground text-foreground' : 'border-transparent text-faint hover:text-muted-foreground',
                  )}
                >
                  {tab.label}
                  <small className={cn('text-[12.5px] font-medium tabular-nums', on ? 'text-muted-foreground' : 'text-faint')}>
                    {tab.count}
                  </small>
                </button>
              );
            })}
          </div>

          {shown.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm leading-relaxed text-muted-foreground sm:px-6">{t('noUnread')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {shown.map((c) => {
                const on = selected === c.id;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => handleOpenConversation(c.id)}
                      className={cn(
                        'grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 px-5 py-4 text-left transition-colors sm:px-6',
                        on ? 'bg-brand-subtle shadow-[inset_3px_0_0_var(--primary)]' : 'hover:bg-muted/60',
                      )}
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm font-semibold">
                          <span className="min-w-0 truncate">{displayName(c, personLabel)}</span>
                          <ChannelChip source={c.source} />
                          {c.escalated && <EscalatedBadge />}
                        </div>
                        <p className="mt-1 truncate text-sm text-muted-foreground">
                          {c.lastMessageBody ?? t('noContent')}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-1.5 pt-0.5">
                        <span className="whitespace-nowrap text-[12.5px] text-faint tabular-nums">{timeAgo(c.lastMessageAt, t)}</span>
                        {c.unread && <span className="h-[7px] w-[7px] rounded-full bg-primary" aria-label={t('unreadDot')} />}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* 대화 상세 카드 — 헤더 / 타임라인 / 답장. 답장 칸은 카드 «바닥»에 붙어 대화의 일부로 읽힌다 */}
        <section className="card-surface flex min-w-0 flex-col overflow-hidden" aria-label={t('detailLabel')}>
          {!current ? (
            <div className="flex flex-col items-center gap-3 px-5 py-14 text-center sm:px-6">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/emoji/speech_balloon_3d.png" alt="" aria-hidden width={44} height={44} className="h-11 w-11" />
              {/* 딥링크를 못 찾았을 때의 안내는 선택된 대화가 없을 때 나온다 — 답장 칸 밑에만 두면 아무도 못 본다 */}
              {notice && <p className="text-[12.5px] text-brand-strong">{notice}</p>}
              <p className="text-sm leading-relaxed text-muted-foreground">{t('selectPrompt')}</p>
            </div>
          ) : (
            <>
              {/* I-33 — 오른쪽 묶음이 shrink-0 이면 사이트 주소 길이만큼 가로로 넘친다(390px). 원인은 flex 자식의
                  기본 min-width:auto 라 이름에 min-w-0 을 준다. 좁으면 이름이 basis-full 로 한 줄을 독차지하고
                  주소·연락처·닫기는 다음 줄로 내려간다. */}
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-border px-5 pb-4 pt-5 sm:px-6 sm:pt-6">
                <h2 className="flex min-w-0 flex-1 basis-full flex-wrap items-center gap-2 text-xl font-bold tracking-[-0.02em] sm:basis-auto">
                  <span className="min-w-0 truncate">{displayName(current, personLabel)}</span>
                  <ChannelChip source={current.source} />
                  {current.escalated && <EscalatedBadge />}
                </h2>
                <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-2.5 gap-y-1">
                  <span className="flex min-w-0 items-center gap-2 text-[12.5px] text-muted-foreground">
                    {origin && (
                      <>
                        <span className="min-w-0 truncate" title={t('originTitle', { origin })}>
                          {originLabel(origin)}
                        </span>
                        <span className="text-border-strong" aria-hidden>·</span>
                      </>
                    )}
                    <span className="min-w-0 truncate" title={current.contactEmail ?? current.contactPhone ?? undefined}>
                      {current.contactEmail ?? current.contactPhone ?? t('noContact')}
                    </span>
                  </span>
                  {convStatus === 'closed' ? (
                    <span className="whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-[12.5px] font-semibold text-muted-foreground">
                      {t('closed')}
                    </span>
                  ) : role === 'approver' ? (
                    <span className="whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-[12.5px] font-semibold text-muted-foreground">
                      {t('approver')}
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={handleCloseConversation}
                      disabled={closing}
                      className="shrink-0"
                    >
                      {closing ? <Loader2 className="animate-spin" /> : t('closeConversation')}
                    </Button>
                  )}
                </div>
                {convStatus !== 'closed' && role === 'owner' && (
                  <p className="basis-full text-left text-[12.5px] text-faint sm:text-right">
                    {current.source === 'channel' ? t('closeHintChannel') : t('closeHint')}
                  </p>
                )}
                {current.ownerEmailStatus && (
                  <p className="basis-full text-[12.5px] text-muted-foreground" title={current.ownerEmailError ?? undefined}>
                    {t(`handoffEmail.${current.ownerEmailStatus === 'sent' || current.ownerEmailStatus === 'failed' ? current.ownerEmailStatus : 'unknown'}`)}
                  </p>
                )}
              </div>

              {/* 환불 요청 카드(3단계) — 타임라인 위. 대기 중이면 승인·거절, 끝났으면 결과만 */}
              {paymentActions.length > 0 && (
                <div className="flex flex-col gap-3 border-b border-border bg-muted/30 px-5 py-4 sm:px-6">
                  {paymentActions.map((a) => (
                    <PaymentActionCard key={a.id} action={a} onDecide={handleDecidePayment} disabled={demo.isDemo} />
                  ))}
                </div>
              )}

              {/* 결제 내역(5단계 6번) — 이 대화의 환불·구매, 장부와 같은 실행 기록. 읽기 전용, 없으면 안 보인다 */}
              <PaymentActivityPanel
                key={current.id}
                rows={paymentRows}
                hasCard={(actionId) => !demo.isDemo && paymentActions.some((a) => a.id === actionId && a.decidable)}
              />

              <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto px-5 py-5 sm:px-6">
                {timeline.map((it) => (
                  <Bubble
                    key={it.id}
                    item={it}
                    userLabel={personLabel(current.source)}
                    context={contexts[it.id]}
                    shot={shots[it.id]}
                  />
                ))}
              </div>

              {/* 답장 — 카드 바닥. 바탕을 한 톤 내려 「여기서 이어 쓴다」가 대화와 한 덩어리로 보이게 */}
              <div className="flex flex-col gap-2 border-t border-border bg-muted/40 px-5 py-4 sm:px-6">
                {role === 'approver' ? (
                  /* 승인자(데모 봇의 심사위원)는 환불 카드만 누른다. 입력창을 두면 403 을 보게 된다. */
                  <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
                    <Clock className="mt-0.5 h-3 w-3 shrink-0 text-faint" aria-hidden />
                    {t('approverNote')}
                  </p>
                ) : current.source === 'channel' ? (
                  /* 채널톡은 답장 창구가 데스크 하나다. 여기에 입력창을 두면 두 곳이 되고
                     「누가 이미 답했나」가 흐려진다 — 그래서 링크만 둔다. */
                  <>
                    <a
                      href={deskUrl ?? 'https://desk.channel.io'}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex h-11 items-center justify-center gap-1.5 self-start rounded-full bg-foreground px-5 text-sm font-semibold text-background"
                    >
                      {t('channelReply')}
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                    </a>
                    <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
                      <Clock className="mt-0.5 h-3 w-3 shrink-0 text-faint" aria-hidden />
                      {t('channelNote')}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="relative flex gap-2">
                      {/* 연습용 화면에서 «어디에 쓰는지»를 짚어 준다. 한 번 보내면 사라진다. */}
                      <DemoHint
                        show={demo.isDemo && !demoReplied}
                        label={t('replyHint')}
                      />
                      <Textarea
                        value={reply}
                        onChange={(e) => setReply(e.target.value)}
                        placeholder={t('replyPlaceholder')}
                        className="min-h-11 flex-1 resize-none rounded-[12px] border-border-strong bg-card px-3.5 py-[11px] shadow-none"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleSendReply();
                          }
                        }}
                      />
                      <Button onClick={handleSendReply} disabled={sending || !reply.trim()}>
                        {sending ? <Loader2 className="animate-spin" /> : t('send')}
                      </Button>
                    </div>
                    <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
                      <Clock className="mt-0.5 h-3 w-3 shrink-0 text-faint" aria-hidden />
                      {current.source === 'kakao'
                        ? current.contactEmail
                          ? t('replyNote.kakaoEmail', { email: current.contactEmail })
                          : t('replyNote.kakao')
                        : current.contactEmail
                          ? t('replyNote.webEmail', { email: current.contactEmail })
                          : t('replyNote.web')}
                    </p>
                  </>
                )}
                {notice && <p className="text-[12.5px] text-brand-strong">{notice}</p>}
                {error && <p className="text-[12.5px] text-destructive">{error}</p>}
              </div>
            </>
          )}
        </section>
      </div>
      )}
    </div>
  );
}
