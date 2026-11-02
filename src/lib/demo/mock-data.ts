import { groupPriority, compareGroupPriority } from '@/lib/groups/priority-score';
import { escalationNotice } from '@/lib/bot/holding';
import type { PickedShotData } from '@/lib/widget/picked-shot';
import type { DashboardPayments } from '@/app/api/dashboard/route';
import { ledgerConversationHref, type LedgerActionRow, type LedgerPurchaseRow, type LedgerRow } from '@/lib/paypal/ledger';
import { refundReasons, type RefundInsightSource, type RefundReasons, type RefundSource } from '@/lib/dashboard/refund-reasons';
import { CHECK_LABELS, type PaymentActionView } from '@/lib/paypal/action-view';
import type { PaymentPrecedent } from '@/lib/paypal/precedent';
import { formatMoney } from '@/lib/paypal/money';
import { copy as enCopy } from './mock-copy.en';
import { copy as koCopy, type DemoCopy } from './mock-copy.ko';

export type DemoPageKey =
  | 'dashboard'
  | 'inbox'
  | 'classify'
  | 'monitor'
  | 'bots'
  | 'botsNew';

// 데모 타임스탬프는 "N분 전"으로 읽히도록 현재 기준으로 만든다.
// 고정 날짜를 박아두면 시간이 지날수록 "162일 전" 같은 죽은 데모가 된다.
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

/** 데모 받은편지함의 결제 대화 — Agency 구매와 $79 승인 대기 환불이 이 대화에서 났다. 장부 「Open」 링크가 여기로 온다. */
const DEMO_PAYMENT_CONV = 'demo-conv-6';

/** Pro 를 샀다가 기대한 기능(Vercel 환경변수 동기화)이 없어 환불받은 대화. 환불 사유 카드의 「기능 요청」이 여기서 났다. */
const DEMO_PRO_CONV = 'demo-conv-7';

/** 쿠폰 버그 묶음(demo-group-1)의 수정 PR — 피드백·묶음 카드와 같은 주소. */
const DEMO_PR_128 = 'https://github.com/example/demo/pull/128';

/** 대시보드 장부 예시 행. 상품·금액은 데모 상점(`scripts/seed-demo.ts`: Starter $9 · Pro $29 · Agency $79)과 같다. */
function demoLedger(c: DemoCopy): LedgerRow[] {
  const refund = (o: {
    n: string; at: number; status: LedgerActionRow['status']; origin: LedgerActionRow['origin']; cents: number;
    reason: string; failedChecks?: string[]; decidedAt?: number; executedAt?: number; error?: string; conv?: string;
  }): LedgerActionRow => ({
    key: `action:demo-refund-${o.n}`,
    type: 'refund',
    id: `demo-refund-${o.n}`,
    at: minutesAgo(o.at),
    status: o.status,
    origin: o.origin,
    amountCents: o.cents,
    currency: 'USD',
    conversationId: o.conv ?? null,
    decidable: o.status === 'pending',
    detail: {
      kind: 'refund',
      targetId: `DEMO${o.n}CAPTURE00000000`.slice(0, 17),
      paypalRef: o.executedAt !== undefined ? `DEMO${o.n}REFUND000000000`.slice(0, 17) : null,
      reason: o.reason,
      failedChecks: o.failedChecks ?? [],
      // 실패 예시(CAPTURE_NOT_REFUNDABLE)는 보내기 전 결제 확인에서 멈춘 것 — PayPal 로 나간 금액이 없다.
      sent: o.executedAt !== undefined ? { value: (o.cents / 100).toFixed(2), currency: 'USD' } : null,
      resultStatus: o.executedAt !== undefined ? 'COMPLETED' : null,
      error: o.error ?? null,
      createdAt: minutesAgo(o.at),
      decidedAt: o.decidedAt !== undefined ? minutesAgo(o.decidedAt) : null,
      decidedBy: o.decidedAt !== undefined ? { self: false, name: null } : null,
      executedAt: o.executedAt !== undefined ? minutesAgo(o.executedAt) : null,
      updatedAt: minutesAgo(o.executedAt ?? o.decidedAt ?? o.at),
    },
  });
  const purchase = (o: { n: string; at: number; status: LedgerPurchaseRow['status']; product: string; cents: number; refunded?: number; refundedAt?: number; conv?: string }): LedgerPurchaseRow => ({
    key: `order:demo-order-${o.n}`,
    type: 'purchase',
    id: `DEMO${o.n}ORDER0000000000`.slice(0, 17),
    at: minutesAgo(o.at),
    status: o.status,
    origin: null,
    amountCents: o.cents,
    currency: 'USD',
    conversationId: o.conv ?? null,
    decidable: false,
    detail: {
      orderId: `DEMO${o.n}ORDER0000000000`.slice(0, 17),
      captureId: `DEMO${o.n}CAPTURE00000000`.slice(0, 17),
      product: o.product,
      quantity: 1,
      refundedCents: o.refunded ?? 0,
      capturedAt: minutesAgo(o.at - 2),
      refundedAt: o.refundedAt !== undefined ? minutesAgo(o.refundedAt) : null,
    },
  });
  return [
    refund({ n: '1', at: 35, status: 'pending', origin: 'approval', cents: 7900, reason: c.ledgerReasonAgency, failedChecks: ['amount_within_max'], conv: DEMO_PAYMENT_CONV }),
    purchase({ n: '1', at: 2_880, status: 'captured', product: 'Agency', cents: 7900, conv: DEMO_PAYMENT_CONV }),
    refund({ n: '2', at: 190, status: 'executed', origin: 'auto', cents: 2900, reason: c.ledgerReasonEnv, executedAt: 190, conv: DEMO_PRO_CONV }),
    purchase({ n: '2', at: 250, status: 'refunded', product: 'Pro', cents: 2900, refunded: 2900, refundedAt: 189, conv: DEMO_PRO_CONV }),
    refund({ n: '3', at: 1_500, status: 'failed', origin: 'approval', cents: 2900, reason: c.ledgerReasonPro, failedChecks: ['customer_known'], decidedAt: 1_420, error: 'CAPTURE_NOT_REFUNDABLE' }),
    // 쿠폰 버그(demo-group-1)를 제보한 두 사람이 정가로 산 Starter 를 환불받았다 — 제보(47·44분 전)와 묶음 생성(35분 전) 뒤다.
    refund({ n: '4', at: 30, status: 'executed', origin: 'auto', cents: 900, reason: c.ledgerReasonStarter, executedAt: 30, conv: 'demo-conv-4' }),
    refund({ n: '5', at: 26, status: 'executed', origin: 'auto', cents: 900, reason: c.ledgerReasonStarter, executedAt: 26, conv: 'demo-conv-5' }),
    // 같은 쿠폰 버그로 24시간 안에 들어온 세 번째 환불 요청 — 승인 대기 중 거절됐다. 환불 사유 카드의 「급증」 표시가 이 건에서 나온다(24시간 3건).
    refund({ n: '6', at: 20, status: 'rejected', origin: 'approval', cents: 900, reason: c.ledgerReasonStarter, failedChecks: ['customer_known'], decidedAt: 14, conv: 'demo-conv-1' }),
    purchase({ n: '5', at: 40, status: 'refunded', product: 'Starter', cents: 900, refunded: 900, refundedAt: 26, conv: 'demo-conv-5' }),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) satisfies LedgerRow[];
}

/**
 * 대시보드 환불 사유 카드 예시 — 손으로 쓴 숫자가 아니라 **실제 집계 함수**(`refundReasons`)에 데모 재료를 넣은 결과다.
 * 재료는 장부의 환불 행 + 각 환불 턴(환불 직전의 방문자 메시지) + 그 턴이 분류된 인사이트 + PR #128 실행.
 *   - Starter 3건(conv-4·conv-5·conv-1, 쿠폰이 안 나와 정가 결제) → 같은 대화의 쿠폰 버그 제보(demo-ins-6·7·1)에 `extend` 로 붙는다.
 *     conv-1 의 환불은 거절(rejected)됐지만 환불 요청이라 센다 — 24시간 3건이라 이 항목에 「급증」이 붙는다.
 *     새 인사이트가 생기지 않으니 묶음 demo-group-1 의 「인사이트 3 · 대화 3」은 그대로다 → bug → PR #128
 *   - Pro 1건(conv-7, 기대한 기능이 없음) → 새 feature_request 인사이트(묶이지 않음) → 기능 요청
 *   - Agency 1건(conv-6, 팀이 줄었음) → 새 cs 인사이트 → 기타
 *   - Pro 1건(실패, 대화 없음, 실수로 두 번 결제) → 대화가 없으니 분류할 인사이트도 없다 → 미분류
 */
function demoRefundReasons(c: DemoCopy, ledger: LedgerRow[]): RefundReasons {
  const refunds: RefundSource[] = ledger
    .filter((r): r is LedgerActionRow => r.type === 'refund')
    .map((r) => ({ id: r.id, conversation_id: r.conversationId, reason: r.detail.reason, created_at: r.at }));
  const linked = refunds.filter((r) => r.conversation_id !== null);
  // 환불 턴 = 환불 30초 전 방문자 메시지(사유를 말한 턴). 사유가 이 메시지로 분류된다.
  const turns = linked.map((r) => ({ id: `${r.id}-turn`, conversation_id: r.conversation_id, created_at: new Date(Date.parse(r.created_at) - 30_000).toISOString() }));
  const turnIn = (conversation: string) => turns.find((t) => t.conversation_id === conversation)?.id ?? null;
  const refundAt = (conversation: string) => linked.find((r) => r.conversation_id === conversation)?.created_at ?? minutesAgo(0);
  const after = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000).toISOString();
  const insight = (o: Omit<RefundInsightSource, 'source_message_ids' | 'group_id'> & Partial<RefundInsightSource>): RefundInsightSource => ({
    source_message_ids: [],
    group_id: null,
    ...o,
  });
  const couponReport = (id: string, messageId: string, conversation: string, at: number) =>
    insight({ id, message_id: messageId, source_message_ids: [turnIn(conversation)].filter((x): x is string => x !== null), group_id: 'demo-group-1', category: 'bug', summary: c.groupTitle, created_at: minutesAgo(at) });
  return refundReasons({
    refunds,
    messages: [
      ...turns,
      // 쿠폰 버그 제보 — 대시보드 피드백 목록의 demo-msg-6·7 과 같은 메시지
      { id: 'demo-msg-6', conversation_id: 'demo-conv-4', created_at: minutesAgo(47) },
      { id: 'demo-msg-7', conversation_id: 'demo-conv-5', created_at: minutesAgo(44) },
      { id: 'demo-msg-1', conversation_id: 'demo-conv-1', created_at: minutesAgo(52) },
    ],
    insights: [
      couponReport('demo-ins-6', 'demo-msg-6', 'demo-conv-4', 47),
      couponReport('demo-ins-7', 'demo-msg-7', 'demo-conv-5', 44),
      couponReport('demo-ins-1', 'demo-msg-1', 'demo-conv-1', 52),
      insight({ id: 'demo-ins-refund-env', message_id: turnIn(DEMO_PRO_CONV), category: 'feature_request', summary: c.envSummary, created_at: after(refundAt(DEMO_PRO_CONV), 20) }),
      insight({ id: 'demo-ins-refund-team', message_id: turnIn(DEMO_PAYMENT_CONV), category: 'cs', summary: c.refundReasonTeam, created_at: after(refundAt(DEMO_PAYMENT_CONV), 20) }),
    ],
    runs: [{ insight_id: null, group_id: 'demo-group-1', status: 'completed', pr_url: DEMO_PR_128, closed_at: null, created_at: minutesAgo(22) }],
    groups: [{ id: 'demo-group-1', title: c.groupTitle }],
  });
}

/**
 * 승인 대기 장부 행 → 받은편지함 승인 카드(`/api/inbox/[id]` 의 paymentActions 와 같은 모양). 실패한 검사만 false,
 * 나머지는 통과. 데모라 카드 버튼은 꺼진다.
 */
function demoApprovalCard(row: LedgerActionRow): PaymentActionView {
  const failed = new Set(row.detail.failedChecks);
  return {
    id: row.id,
    kind: row.detail.kind,
    status: row.status,
    origin: row.origin,
    amountCents: row.amountCents,
    currency: row.currency,
    amount: row.amountCents !== null && row.currency ? formatMoney(row.amountCents, row.currency) : null,
    reason: row.detail.reason,
    captureId: row.detail.targetId,
    checks: Object.entries(CHECK_LABELS).map(([key, label]) => ({ key, label, passed: !failed.has(key) })),
    paypalRef: row.detail.paypalRef,
    error: row.detail.error,
    createdAt: row.detail.createdAt,
    decidedAt: row.detail.decidedAt,
    decidable: row.decidable,
  };
}

/**
 * 승인 카드의 「같은 검사에서 멈춘 과거 요청」 — 장부의 실제 환불 행으로 만든다(손으로 쓴 숫자가 아니다).
 * 5건 중 4건을 승인했고 1건(실패한 Pro)은 거절됐다. 근거 링크는 데모 받은편지함의 같은 대화들이다.
 */
function demoPrecedent(ledger: LedgerRow[]): PaymentPrecedent {
  const evidence = ledger
    .filter((r): r is LedgerActionRow => r.type === 'refund' && r.status === 'executed' && r.conversationId !== null)
    .slice(0, 3)
    .map((r) => ({
      actionId: r.id,
      conversationId: r.conversationId!,
      href: ledgerConversationHref(r.conversationId!),
      status: r.status,
      amount: r.amountCents !== null && r.currency ? formatMoney(r.amountCents, r.currency) : null,
      at: r.at,
      sample: false,
    }));
  // Evidence rows are the demo's auto refunds, so the line uses the amount basis (not "stopped by the same check").
  return { basis: 'amount', total: 5, refunded: 4, rejected: 1, auto: evidence.length, evidence };
}

/** 언어마다 문구가 다른 연습용 데이터(`mock-copy.en.ts` · `mock-copy.ko.ts`). 구조·숫자·시각은 같다. */
function buildDemoData(c: DemoCopy, l: 'en' | 'ko'): Record<DemoPageKey, unknown> {
  // 장부 예시 행 — 대시보드 장부와 받은편지함 결제 대화가 같은 행을 쓴다(숫자가 어긋나지 않게).
  const ledger = demoLedger(c);
  const paymentConvRows = ledger.filter((r) => r.conversationId === DEMO_PAYMENT_CONV);
  const pendingRefund = paymentConvRows.find((r): r is LedgerActionRow => r.type === 'refund' && r.status === 'pending');
  // 「화면에서 선택하기」 예시(I-55) — 데모 사이트 경복궁 페이지에서 「쿠폰 받기」를 짚는 순간 찍은 화면(1280×800).
  // 정적 자산이라 서명 URL 이 아니다. 좌표는 그 화면에서 실측한 값이다. 언어마다 찍은 화면이 달라
  // (영어판 `/en/spots/...` 는 버튼 글자가 길다) 화면 파일·주소·좌표를 같이 바꾼다.
  const pickPageUrl = l === 'ko'
    ? 'https://nullnul-tour-demo.vercel.app/spots/gyeongbokgung'
    : 'https://nullnul-tour-demo.vercel.app/en/spots/gyeongbokgung';
  const DEMO_PICK_CONTEXT = {
    url: pickPageUrl,
    viewport: '1280x800',
    user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
    target: {
      kind: c.pickKind,
      tag: 'button',
      selector: 'section:nth-of-type(3) > div:nth-of-type(1) > button',
      text: c.couponButton,
      rect: l === 'ko' ? { x: 828, y: 371, w: 84, h: 44 } : { x: 804, y: 378, w: 107, h: 44 },
      url: pickPageUrl,
      shot: '00000000-0000-4000-8000-00000000d1c0',
    },
  };
  const DEMO_PICK_SHOT = { url: l === 'ko' ? '/demo/picked-shot.ko.webp' : '/demo/picked-shot.webp', width: 1280, height: 800 };
  const DEMO_PICKED: PickedShotData = {
    label: c.pickLabel,
    selector: DEMO_PICK_CONTEXT.target.selector,
    rect: DEMO_PICK_CONTEXT.target.rect,
    viewport: { w: 1280, h: 800 },
    shot: DEMO_PICK_SHOT,
    hadShot: true,
    pageUrl: DEMO_PICK_CONTEXT.target.url,
  };

  return {
    dashboard: {
      // 「피드백 채널」 칸. /bots 데모 봇(rona.so)과 같은 사실 — 위젯은 붙었고 채널톡은 아직이다.
      channels: { web: true, channel: false },
      // 되돌림은 아직 구현 전이라 데모에서도 0이다 — 없는 기능을 숫자로 주장하지 않는다.
      // `loopTime` 은 전달된 되돌림 4건의 평균(2.4일) — `returned: 4` 와 표본 수가 같아야 앞뒤가 맞는다.
      // `confirmation` 의 분모는 **웹 위젯 대화의** 전달된 되돌림이다(답을 받는 길이 위젯 카드뿐이라
      // 실데이터도 web 으로 좁힌다). 데모의 되돌림 4건은 전부 웹 대화이고, 3명이 답해 2명이 「잘 돼요」.
      // `githubReadyBotIds` 는 F6 체크리스트 ③ 의 재료다. 데모는 제보가 47건이라 체크리스트 자체가 숨는다.
      stats: { collected: 47, classified: 41, prCreated: 6, returned: 4, loopTime: { state: 'ok', sampleSize: 4, averageMs: 207_360_000 }, confirmation: { state: 'ok', fixed: 2, notFixed: 1, delivered: 4 }, githubReadyBotIds: ['demo-bot-1'] },
      // PayPal 줄(`/api/dashboard` 의 `payments` 와 같은 모양). 데모 봇은 공용 키로 연결된 봇이라 connected,
      // 연결할 내 봇이 없으니 connectBotId 는 null.
      // `refundReasons` 는 장부의 환불 6건을 실제 집계 함수로 나눈 결과다(`demoRefundReasons` 주석) —
      // 버그 3(→ PR #128, 24시간 3건이라 급증) · 기능 요청 1 · 기타 1 · 미분류 1.
      payments: {
        connected: true,
        connectBotId: null,
        inquiries7d: 12,
        autoRefunds7d: { count: 3, amountCents: 4700, currency: 'USD' },
        pendingApprovals: 1,
        refundReasons: demoRefundReasons(c, ledger),
      } satisfies DashboardPayments,
      // 장부 예시 행(`/api/payments/ledger` 의 rows 와 같은 모양). 위 숫자와 맞춘다 — 자동 환불 3건 $9+$9+$29 = $47,
      // 승인 대기 1건(Agency $79, 자동 한도 초과). 실패 1건, 구매 3건. 실패한 Pro 환불만 대화가 없어 「—」이고,
      // 나머지는 데모 받은편지함 대화(conv-4·5·6·7)로 이어진다. 버튼은 데모라 꺼진다.
      ledger,
      feedbacks: [
        {
          id: 'demo-msg-1',
          userName: c.name1,
          content: c.say,
          source: 'web',
          createdAt: minutesAgo(52),
          botResponse: c.reply1,
          insight: { id: 'demo-ins-1', category: 'bug', summary: c.groupTitle },
          pr: { url: 'https://github.com/example/demo/pull/128', number: 128 },
          returnedAt: minutesAgo(8),
        },
        // 편지함의 `demo-conv-4`·`demo-conv-5` 와 같은 사람들. 대시보드 목록에서도 같은 얘기가
        // 여러 번 들어왔다는 것이 보여야 묶음 카드의 「4건 · 3명」이 앞뒤가 맞는다.
        {
          id: 'demo-msg-6',
          userName: c.visitorC1d0,
          content: c.sayB,
          source: 'web',
          createdAt: minutesAgo(47),
          botResponse: c.replyB,
          insight: { id: 'demo-ins-6', category: 'bug', summary: c.groupTitle },
          pr: { url: 'https://github.com/example/demo/pull/128', number: 128 },
          returnedAt: minutesAgo(8),
        },
        {
          id: 'demo-msg-7',
          userName: c.visitorD42f,
          content: c.sayC,
          source: 'web',
          createdAt: minutesAgo(44),
          botResponse: c.replyC,
          insight: { id: 'demo-ins-7', category: 'bug', summary: c.groupTitle },
          pr: { url: 'https://github.com/example/demo/pull/128', number: 128 },
          returnedAt: minutesAgo(8),
        },
        {
          id: 'demo-msg-2',
          userName: c.name2,
          content: c.sayDark,
          source: 'web',
          createdAt: minutesAgo(40),
          botResponse: c.replyDark,
          insight: { id: 'demo-ins-2', category: 'ux', summary: c.darkSummary },
          pr: null,
          returnedAt: null,
        },
        {
          id: 'demo-msg-3',
          userName: c.name3,
          content: c.sayLoop,
          source: 'channel',
          createdAt: minutesAgo(28),
          botResponse: null,
          insight: { id: 'demo-ins-3', category: 'bug', summary: c.loopSummary },
          pr: null,
          returnedAt: null,
        },
        {
          id: 'demo-msg-4',
          userName: c.name4,
          content: c.sayEnv,
          source: 'web',
          createdAt: minutesAgo(15),
          botResponse: null,
          insight: { id: 'demo-ins-4', category: 'feature_request', summary: c.envSummary },
          pr: null,
          returnedAt: null,
        },
        {
          id: 'demo-msg-5',
          userName: c.name5,
          content: c.sayPraise,
          source: 'web',
          createdAt: minutesAgo(4),
          botResponse: c.replyPraise,
          insight: { id: 'demo-ins-5', category: 'praise', summary: c.praiseSummary },
          pr: null,
          returnedAt: null,
        },
      ],
      groups: [
        {
          id: 'demo-group-1',
          title: c.groupTitle,
          summary: c.groupSummary,
          category: 'bug',
          status: 'merged',
          createdAt: minutesAgo(35),
          // ⚠️ 「수정 PR」 화면이 같은 묶음을 「근거 피드백 3건 · 3명」이라고 말한다(인사이트 3건에서
          //    세어 온다). 여기만 4 로 두면 묶음 화면과 PR 화면의 숫자가 어긋난다 — 가이드 데모는
          //    그 둘을 연달아 보여주므로 바로 눈에 띈다(2026-09-18 실측).
          insightCount: 3,
          conversationCount: 3,
          priority: groupPriority(3, 3, true, c.groupReason1),
          specDraft: null,
          triage: 'fix',
          triageReason: c.triageFixReason,
          pr: { url: 'https://github.com/example/demo/pull/128', number: 128, mergedAt: minutesAgo(10) },
        },
        {
          id: 'demo-group-2',
          title: c.groupDarkTitle,
          summary: c.groupDarkSummary,
          category: 'ux',
          status: 'open',
          createdAt: minutesAgo(41),
          insightCount: 2,
          conversationCount: 2,
          priority: groupPriority(2, 2, false, c.groupReason2),
          specDraft: null,
          triage: 'needs_decision',
          triageReason: c.triageDecisionReason,
          pr: null,
          returnedAt: null,
        },
        {
          id: 'demo-group-3',
          title: c.group3Title,
          summary: c.group3Summary,
          category: 'cs',
          status: 'open',
          createdAt: minutesAgo(18),
          insightCount: 1,
          conversationCount: 1,
          priority: groupPriority(1, 1),
          specDraft: null,
          triage: 'wont_fix',
          triageReason: c.triageWontFixReason,
          pr: null,
          returnedAt: null,
        },
      ].sort(compareGroupPriority),
      events: [
        { id: 'demo-ev-1', kind: 'classified', title: c.praiseSummary, detail: `${c.classifiedPrefix}praise`, at: minutesAgo(3) },
        { id: 'demo-ev-2', kind: 'classified', title: c.envSummary, detail: `${c.classifiedPrefix}feature_request`, at: minutesAgo(14) },
        { id: 'demo-ev-3', kind: 'pr_created', title: c.prCreatedTitle, detail: c.groupTitle, at: minutesAgo(22) },
        { id: 'demo-ev-4', kind: 'classified', title: c.loopSummary, detail: `${c.classifiedPrefix}bug`, at: minutesAgo(27) },
        { id: 'demo-ev-5', kind: 'classified', title: c.darkSummary, detail: `${c.classifiedPrefix}ux`, at: minutesAgo(39) },
        { id: 'demo-ev-6', kind: 'classified', title: c.groupTitle, detail: `${c.classifiedPrefix}bug`, at: minutesAgo(50) },
      ],
    },

    inbox: {
      conversations: [
        {
          id: 'demo-conv-1',
          source: 'web',
          externalUserId: 'a3f21c88-0000-4000-8000-000000000001',
          contactName: c.name1,
          contactEmail: c.email1,
          lastMessageAt: minutesAgo(6),
          lastMessageBody: c.say,
          unread: true,
        },
        // 🔴 아래 둘은 **같은 문제를 말한 다른 사람들**이다. 가이드 데모가 「비슷한 제보 묶기」를
        //    설명할 때 편지함 목록에서 이 셋을 한꺼번에 짚는다(`script.ts` 의 `SIMILAR_SAYS`).
        //    셋이 맨 위에 붙어 있어야 블록으로 짚었을 때 「이것들이 같은 문제」로 읽히므로
        //    시각도 6·11·17분 전으로 잇대어 뒀다. 묶음 카드의 「3명이 말했어요」가 이 셋이다.
        {
          id: 'demo-conv-4',
          source: 'web',
          externalUserId: 'c1d05e22-0000-4000-8000-000000000004',
          contactName: null,
          contactEmail: null,
          lastMessageAt: minutesAgo(11),
          lastMessageBody: c.sayB,
          unread: true,
        },
        {
          id: 'demo-conv-5',
          source: 'web',
          externalUserId: 'd42f7a90-0000-4000-8000-000000000005',
          contactName: null,
          contactEmail: null,
          lastMessageAt: minutesAgo(17),
          lastMessageBody: c.sayC,
          unread: false,
        },
        {
          id: 'demo-conv-2',
          source: 'web',
          externalUserId: 'b7c40d19-0000-4000-8000-000000000002',
          contactName: null,
          contactEmail: null,
          lastMessageAt: minutesAgo(22),
          lastMessageBody: c.sayDark,
          unread: false,
        },
        // 결제 대화 — 이틀 전 위젯에서 Agency 를 사고, 오늘 환불을 청했는데 자동 한도($79 > 한도)를 넘어 승인 대기.
        // 승인 대기가 생기면 배지가 함께 켜진다(20261021_02) — 대시보드 「승인 대기 1」의 그 건이다.
        {
          id: DEMO_PAYMENT_CONV,
          source: 'web',
          externalUserId: 'e5a19b37-0000-4000-8000-000000000006',
          contactName: null,
          contactEmail: null,
          lastMessageAt: minutesAgo(35),
          lastMessageBody: c.payRefundPending,
          unread: true,
          escalated: true,
        },
        {
          id: 'demo-conv-3',
          source: 'web',
          externalUserId: '031a83d27853db2250ebac5d',
          contactName: null,
          contactEmail: null,
          lastMessageAt: minutesAgo(48),
          lastMessageBody: c.sayBooking,
          unread: false,
          // 답변 지식에 없어서 AI 가 사람에게 넘긴 대화. 배지가 실제로 어떻게 보이는지 데모에 남긴다.
          escalated: true,
        },
        // 결제 대화 둘째 — Pro 를 샀는데 기대한 기능이 없어 자동 환불($29, 한도 안). 환불 사유 카드의 「기능 요청」이 이 건이다.
        {
          id: DEMO_PRO_CONV,
          source: 'web',
          externalUserId: 'f6b28c41-0000-4000-8000-000000000007',
          contactName: null,
          contactEmail: null,
          lastMessageAt: minutesAgo(190),
          lastMessageBody: c.payRefundDonePro,
          unread: false,
        },
      ],
      contexts: { 'demo-conv-4': { 'd4-1': DEMO_PICK_CONTEXT } },
      shots: { 'demo-conv-4': { 'd4-1': DEMO_PICK_SHOT } },
      timelines: {
        'demo-conv-1': [
          { id: 'd1-1', kind: 'user', body: c.say, at: minutesAgo(6) },
          { id: 'd1-2', kind: 'ai', body: c.aiReply1, at: minutesAgo(6) },
        ],
        'demo-conv-4': [
          { id: 'd4-1', kind: 'user', body: c.sayB, at: minutesAgo(11) },
          { id: 'd4-2', kind: 'ai', body: c.aiReply1, at: minutesAgo(11) },
        ],
        'demo-conv-5': [
          { id: 'd5-1', kind: 'user', body: c.sayC, at: minutesAgo(17) },
          { id: 'd5-2', kind: 'ai', body: c.aiReplyC, at: minutesAgo(17) },
        ],
        'demo-conv-2': [
          { id: 'd2-1', kind: 'user', body: c.sayDark, at: minutesAgo(22) },
          { id: 'd2-2', kind: 'ai', body: c.aiDark, at: minutesAgo(22) },
          { id: 'd2-3', kind: 'operator', body: c.operatorDark, at: minutesAgo(14) },
        ],
        'demo-conv-3': [
          { id: 'd3-1', kind: 'user', body: c.sayBooking, at: minutesAgo(48) },
          { id: 'd3-2', kind: 'ai', body: c.aiBooking, at: minutesAgo(48) },
          // 방문자가 위젯의 「상담원 연결」을 누른 기록 (B2). 배지가 켜진 이유가 타임라인에 보인다.
          { id: 'd3-3', kind: 'notice', body: escalationNotice({ locale: l, quote: c.sayBooking, hasEmail: false, statusText: c.statusText }), at: minutesAgo(46) },
          { id: 'd3-4', kind: 'system', body: c.systemBooking, at: minutesAgo(30) },
        ],
        [DEMO_PAYMENT_CONV]: [
          { id: 'd6-1', kind: 'user', body: c.sayBuyAgency, at: minutesAgo(2_881) },
          { id: 'd6-2', kind: 'payment', body: c.payCheckoutAgency, at: minutesAgo(2_880) },
          { id: 'd6-3', kind: 'user', body: c.ledgerReasonAgency, at: minutesAgo(35) },
          { id: 'd6-4', kind: 'payment', body: c.payRefundPending, at: minutesAgo(35) },
        ],
        [DEMO_PRO_CONV]: [
          { id: 'd7-1', kind: 'user', body: c.sayBuyPro, at: minutesAgo(251) },
          { id: 'd7-2', kind: 'payment', body: c.payCheckoutPro, at: minutesAgo(250) },
          { id: 'd7-3', kind: 'user', body: c.ledgerReasonEnv, at: minutesAgo(190) },
          { id: 'd7-4', kind: 'payment', body: c.payRefundDonePro, at: minutesAgo(190) },
        ],
      },
      // 결제 대화의 승인 카드와 결제 내역 — 대시보드 장부와 같은 행이다. 장부 행이 이어진 대화마다 그 대화의 행만 싣는다.
      payments: Object.fromEntries(
        [...new Set(ledger.map((r) => r.conversationId).filter((id): id is string => id !== null))].map((id) => [
          id,
          id === DEMO_PAYMENT_CONV
            ? { actions: pendingRefund ? [demoApprovalCard(pendingRefund)] : [], rows: paymentConvRows, precedents: pendingRefund ? { [pendingRefund.id]: demoPrecedent(ledger) } : {} }
            : { actions: [], rows: ledger.filter((r) => r.conversationId === id) },
        ]),
      ),
    },

    classify: {
      insights: [
        { id: 'ins-1', classified_by: 'jev', classify_confidence: 0.96, category: 'bug', group_id: 'demo-group-1', summary: c.groupTitle, sentiment: 'negative', follow_up_needed: true, created_at: minutesAgo(52), message_id: 'msg-1', messages: { body: c.say, author_name: c.name1, chat_id: 1001, source: 'web', detected_at: minutesAgo(52) } },
        { id: 'ins-1b', classified_by: 'jev', classify_confidence: 0.94, category: 'bug', group_id: 'demo-group-1', summary: c.groupTitle, sentiment: 'negative', follow_up_needed: true, created_at: minutesAgo(47), message_id: 'msg-1b', messages: { body: c.sayB, author_name: c.visitorC1d0, chat_id: 1001, source: 'web', detected_at: minutesAgo(47) }, picked: DEMO_PICKED },
        { id: 'ins-1c', classified_by: 'jev', classify_confidence: 0.97, category: 'bug', group_id: 'demo-group-1', summary: c.groupTitle, sentiment: 'negative', follow_up_needed: true, created_at: minutesAgo(44), message_id: 'msg-1c', messages: { body: c.sayC, author_name: c.visitorD42f, chat_id: 1001, source: 'web', detected_at: minutesAgo(44) } },
        { id: 'ins-2', classified_by: 'llm', classify_confidence: null, category: 'ux', group_id: 'demo-group-2', summary: c.darkSummary, sentiment: 'negative', follow_up_needed: true, created_at: minutesAgo(40), message_id: 'msg-2', messages: { body: c.sayDark, author_name: c.name2, chat_id: 1001, source: 'web', detected_at: minutesAgo(40) } },
        { id: 'ins-3', category: 'bug', group_id: null, summary: c.loopSummary, sentiment: 'negative', follow_up_needed: true, created_at: minutesAgo(28), message_id: 'msg-3', messages: { body: c.sayLoop, author_name: c.name3, chat_id: 1001, source: 'channel', detected_at: minutesAgo(28) } },
        { id: 'ins-4', category: 'feature_request', group_id: null, summary: c.envSummary, sentiment: 'neutral', follow_up_needed: false, created_at: minutesAgo(15), message_id: 'msg-5', messages: { body: c.sayEnv, author_name: c.name4, chat_id: 1001, source: 'web', detected_at: minutesAgo(15) } },
        { id: 'ins-5', category: 'praise', group_id: null, summary: c.praiseSummary, sentiment: 'positive', follow_up_needed: false, created_at: minutesAgo(9), message_id: 'msg-6', messages: { body: c.sayPraise, author_name: c.name5, chat_id: 1001, source: 'web', detected_at: minutesAgo(9) } },
        { id: 'ins-6', category: 'cs', group_id: null, summary: c.planSummary, sentiment: 'neutral', follow_up_needed: true, created_at: minutesAgo(4), message_id: 'msg-7', messages: { body: c.sayPlan, author_name: c.name6, chat_id: 1001, source: 'web', detected_at: minutesAgo(4) } },
      ],
    },

    monitor: {
      // 수정 PR 목록 — /api/auto-dev/runs 의 RunItem 모양. 되돌림(returns)까지 한 실행에 붙는다.
      runs: [
        {
          id: 'demo-run-1', status: 'completed', createdAt: minutesAgo(46), durationMs: 47200,
          title: c.groupTitle, category: 'bug', repo: 'example/feedloop-demo',
          pr: { url: 'https://github.com/example/feedloop-demo/pull/128', number: 128, mergedAt: minutesAgo(12), closedAt: minutesAgo(12), closeReason: null, closeNote: null },
          filesChanged: [
            { path: 'app/components/PartnerCoupon.tsx', action: 'modified' },
            { path: 'app/lib/coupon/issue.ts', action: 'modified' },
          ],
          errorMessage: null,
          evidence: { insightCount: 3, conversationCount: 3 },
          demoPickedShots: [DEMO_PICKED],
          returns: [
            { conversationId: 'demo-conv-1', source: 'web', name: c.name1, deliveredAt: minutesAgo(8), confirmation: 'fixed', confirmedAt: minutesAgo(5) },
            { conversationId: 'demo-conv-2', source: 'web', name: c.visitorB7c4, deliveredAt: minutesAgo(8), confirmation: null, confirmedAt: null },
            { conversationId: 'demo-conv-3', source: 'web', name: c.visitor031a, deliveredAt: null, confirmation: null, confirmedAt: null },
          ],
        },
        {
          id: 'demo-run-2', status: 'completed', createdAt: minutesAgo(35), durationMs: 61000,
          title: c.darkSummary, category: 'ux', repo: 'example/feedloop-demo',
          pr: { url: 'https://github.com/example/feedloop-demo/pull/129', number: 129, mergedAt: null, closedAt: null, closeReason: null, closeNote: null },
          filesChanged: [{ path: 'src/components/CodeBlock.tsx', action: 'modified' }],
          errorMessage: null,
          evidence: { insightCount: 2, conversationCount: 2 },
          returns: [],
        },
        {
          id: 'demo-run-3', status: 'failed', createdAt: minutesAgo(20), durationMs: 21000,
          title: c.runPhotoTitle, category: 'ux', repo: 'example/feedloop-demo',
          pr: null, filesChanged: [],
          errorMessage: c.runError,
          evidence: { insightCount: 1, conversationCount: 1 },
          returns: [],
        },
      ],
      lines: [
        // 줄거리는 각본(쿠폰)을 따르고, 말투는 main 의 문구 정책(「저장소」·「수정안」)을 따른다
        { type: 'log', message: c.logStart },
        { type: 'log', message: c.logGroup },
        { type: 'log', message: c.logTree },
        { type: 'log', message: c.logAskFile },
        { type: 'log', message: c.logPicked },
        { type: 'log', message: c.logAskFix },
        { type: 'log', message: c.logPaths },
        { type: 'log', message: c.logCreating },
        { type: 'complete', message: c.logDone },
      ],
    },

    bots: {
      bots: [
        { id: 'demo-bot-1', service_name: c.bot1, bot_username: '@rona_feedback_bot', service_description: c.bot1Desc, status: 'active', created_at: '2026-03-25T09:00:00Z' },
        { id: 'demo-bot-2', service_name: c.bot2, bot_username: '@feedloop_test_bot', service_description: c.bot2Desc, status: 'pending', created_at: '2026-03-27T14:00:00Z' },
      ],
    },

    botsNew: {},
  };
}

const cache: Partial<Record<'en' | 'ko', Record<DemoPageKey, unknown>>> = {};

/** 그 언어의 연습용 데이터. 언어마다 한 번만 만든다(시각은 그때 기준 «N분 전»). 한국어가 아니면 영어. */
export function getDemoData(locale: string): Record<DemoPageKey, unknown> {
  const l = locale === 'ko' ? 'ko' : 'en';
  return (cache[l] ??= buildDemoData(l === 'ko' ? koCopy : enCopy, l));
}
