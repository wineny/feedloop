import { groupPriority, compareGroupPriority } from '@/lib/groups/priority-score';
import { escalationNotice } from '@/lib/bot/holding';
import type { PickedShotData } from '@/lib/widget/picked-shot';

// 「화면에서 선택하기」 예시(I-55) — 데모 사이트 경복궁 페이지에서 「쿠폰 받기」를 짚는 순간 찍은 화면(1280×800).
// 정적 자산이라 서명 URL 이 아니다. 좌표는 그 화면에서 실측한 값이다.
const DEMO_PICK_CONTEXT = {
  url: 'https://nullnul-tour-demo.vercel.app/spots/gyeongbokgung',
  viewport: '1280x800',
  user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  target: {
    kind: '버튼',
    tag: 'button',
    selector: 'section:nth-of-type(3) > div:nth-of-type(1) > button',
    text: '쿠폰 받기',
    rect: { x: 828, y: 371, w: 84, h: 44 },
    url: 'https://nullnul-tour-demo.vercel.app/spots/gyeongbokgung',
    shot: '00000000-0000-4000-8000-00000000d1c0',
  },
};
const DEMO_PICK_SHOT = { url: '/demo/picked-shot.webp', width: 1280, height: 800 };
const DEMO_PICKED: PickedShotData = {
  label: '「쿠폰 받기」 버튼',
  selector: DEMO_PICK_CONTEXT.target.selector,
  rect: DEMO_PICK_CONTEXT.target.rect,
  viewport: { w: 1280, h: 800 },
  shot: DEMO_PICK_SHOT,
  hadShot: true,
  pageUrl: DEMO_PICK_CONTEXT.target.url,
};
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

export const DEMO_DATA: Record<DemoPageKey, unknown> = {
  dashboard: {
    // 「피드백 채널」 칸. /bots 데모 봇(rona.so)과 같은 사실 — 위젯은 붙었고 채널톡은 아직이다.
    channels: { web: true, channel: false },
    // 되돌림은 아직 구현 전이라 데모에서도 0이다 — 없는 기능을 숫자로 주장하지 않는다.
    // `loopTime` 은 전달된 되돌림 4건의 평균(2.4일) — `returned: 4` 와 표본 수가 같아야 앞뒤가 맞는다.
    // `confirmation` 의 분모는 **웹 위젯 대화의** 전달된 되돌림이다(답을 받는 길이 위젯 카드뿐이라
    // 실데이터도 web 으로 좁힌다). 데모의 되돌림 4건은 전부 웹 대화이고, 3명이 답해 2명이 「잘 돼요」.
    // `githubReadyBotIds` 는 F6 체크리스트 ③ 의 재료다. 데모는 제보가 47건이라 체크리스트 자체가 숨는다.
    stats: { collected: 47, classified: 41, prCreated: 6, returned: 4, loopTime: { state: 'ok', sampleSize: 4, averageMs: 207_360_000 }, confirmation: { state: 'ok', fixed: 2, notFixed: 1, delivered: 4 }, githubReadyBotIds: ['demo-bot-1'] },
    feedbacks: [
      {
        id: 'demo-msg-1',
        userName: '이수진',
        content: '쿠폰 다운로드가 잘 안됩니다',
        source: 'web',
        createdAt: minutesAgo(52),
        botResponse: '불편하셨겠어요. 「쿠폰 받기」가 안 되는 문제로 접수했어요. 원인은 짐작하지 않고 팀에 그대로 넘길게요.',
        insight: { id: 'demo-ins-1', category: 'bug', summary: '「쿠폰 받기」를 눌러도 쿠폰이 발급되지 않음' },
        pr: { url: 'https://github.com/example/demo/pull/128', number: 128 },
        returnedAt: minutesAgo(8),
      },
      // 편지함의 `demo-conv-4`·`demo-conv-5` 와 같은 사람들. 대시보드 목록에서도 같은 얘기가
      // 여러 번 들어왔다는 것이 보여야 묶음 카드의 「4건 · 3명」이 앞뒤가 맞는다.
      {
        id: 'demo-msg-6',
        userName: '방문자 #c1d0',
        content: '쿠폰 받기를 눌러도 아무 반응이 없어요',
        source: 'web',
        createdAt: minutesAgo(47),
        botResponse: '불편하셨겠어요. 「쿠폰 받기」가 안 되는 문제로 접수했어요.',
        insight: { id: 'demo-ins-6', category: 'bug', summary: '「쿠폰 받기」를 눌러도 쿠폰이 발급되지 않음' },
        pr: { url: 'https://github.com/example/demo/pull/128', number: 128 },
        returnedAt: minutesAgo(8),
      },
      {
        id: 'demo-msg-7',
        userName: '방문자 #d42f',
        content: '제휴 가게 쿠폰이 발급되지 않습니다',
        source: 'web',
        createdAt: minutesAgo(44),
        botResponse: '같은 제보가 몇 건 더 있어요. 「쿠폰 받기」 문제로 접수했어요.',
        insight: { id: 'demo-ins-7', category: 'bug', summary: '「쿠폰 받기」를 눌러도 쿠폰이 발급되지 않음' },
        pr: { url: 'https://github.com/example/demo/pull/128', number: 128 },
        returnedAt: minutesAgo(8),
      },
      {
        id: 'demo-msg-2',
        userName: '이프론트',
        content: '다크모드에서 코드 블록 테마가 깨져요',
        source: 'web',
        createdAt: minutesAgo(40),
        botResponse: '다크모드 스타일 충돌 확인했습니다. 고칠 준비를 하고 있어요.',
        insight: { id: 'demo-ins-2', category: 'ux', summary: '다크모드 코드 블록 테마 충돌' },
        pr: null,
        returnedAt: null,
      },
      {
        id: 'demo-msg-3',
        userName: '임운영',
        content: '401 에러 후 무한 리다이렉트가 발생합니다',
        source: 'channel',
        createdAt: minutesAgo(28),
        botResponse: null,
        insight: { id: 'demo-ins-3', category: 'bug', summary: '401 인증 루프 — 세션 만료 후 무한 리다이렉트' },
        pr: null,
        returnedAt: null,
      },
      {
        id: 'demo-msg-4',
        userName: '박데브',
        content: 'Vercel 환경변수 자동 동기화 기능 추가해주세요',
        source: 'web',
        createdAt: minutesAgo(15),
        botResponse: null,
        insight: { id: 'demo-ins-4', category: 'feature_request', summary: 'Vercel 환경변수 자동 동기화 요청' },
        pr: null,
        returnedAt: null,
      },
      {
        id: 'demo-msg-5',
        userName: '최유저',
        content: '와 진짜 5분만에 고쳐졌네요 소름 돋습니다',
        source: 'web',
        createdAt: minutesAgo(4),
        botResponse: '피드백 주셔서 고맙습니다! 덕분에 빨리 잡았어요.',
        insight: { id: 'demo-ins-5', category: 'praise', summary: '빠른 버그 대응에 대한 칭찬' },
        pr: null,
        returnedAt: null,
      },
    ],
    groups: [
      {
        id: 'demo-group-1',
        title: '「쿠폰 받기」를 눌러도 쿠폰이 발급되지 않음',
        summary: '전국 지도에서 제휴 가게의 「쿠폰 받기」를 눌러도 쿠폰이 받아지지 않는다는 제보. 모바일·PC 모두에서 보고됨.',
        category: 'bug',
        status: 'merged',
        createdAt: minutesAgo(35),
        // ⚠️ 「수정 PR」 화면이 같은 묶음을 「근거 피드백 3건 · 3명」이라고 말한다(인사이트 3건에서
        //    세어 온다). 여기만 4 로 두면 묶음 화면과 PR 화면의 숫자가 어긋난다 — 가이드 데모는
        //    그 둘을 연달아 보여주므로 바로 눈에 띈다(2026-09-18 실측).
        insightCount: 3,
        conversationCount: 3,
        priority: groupPriority(3, 3, true, '쿠폰 발급이 안 돼 할인 결제를 못 함'),
        specDraft: null,
        pr: { url: 'https://github.com/example/demo/pull/128', number: 128, mergedAt: minutesAgo(10) },
      },
      {
        id: 'demo-group-2',
        title: '다크모드에서 코드 블록 테마가 깨짐',
        summary: '다크모드 전환 시 코드 블록 배경과 글자색이 겹쳐 읽을 수 없다는 제보.',
        category: 'ux',
        status: 'open',
        createdAt: minutesAgo(41),
        insightCount: 2,
        conversationCount: 2,
        priority: groupPriority(2, 2, false, '테마 표시 문제로 핵심 흐름은 막히지 않음'),
        specDraft: null,
        pr: null,
        returnedAt: null,
      },
    ].sort(compareGroupPriority),
    events: [
      { id: 'demo-ev-1', kind: 'classified', title: '빠른 버그 대응에 대한 칭찬', detail: '분류: praise', at: minutesAgo(3) },
      { id: 'demo-ev-2', kind: 'classified', title: 'Vercel 환경변수 자동 동기화 요청', detail: '분류: feature_request', at: minutesAgo(14) },
      { id: 'demo-ev-3', kind: 'pr_created', title: 'PR #128 자동 생성', detail: '「쿠폰 받기」를 눌러도 쿠폰이 발급되지 않음', at: minutesAgo(22) },
      { id: 'demo-ev-4', kind: 'classified', title: '401 인증 루프 — 세션 만료 후 무한 리다이렉트', detail: '분류: bug', at: minutesAgo(27) },
      { id: 'demo-ev-5', kind: 'classified', title: '다크모드 코드 블록 테마 충돌', detail: '분류: ux', at: minutesAgo(39) },
      { id: 'demo-ev-6', kind: 'classified', title: '「쿠폰 받기」를 눌러도 쿠폰이 발급되지 않음', detail: '분류: bug', at: minutesAgo(50) },
    ],
  },

  inbox: {
    conversations: [
      {
        id: 'demo-conv-1',
        source: 'web',
        externalUserId: 'a3f21c88-0000-4000-8000-000000000001',
        contactName: '이수진',
        contactEmail: 'sujin@example.com',
        lastMessageAt: minutesAgo(6),
        lastMessageBody: '쿠폰 다운로드가 잘 안됩니다',
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
        lastMessageBody: '쿠폰 받기를 눌러도 아무 반응이 없어요',
        unread: true,
      },
      {
        id: 'demo-conv-5',
        source: 'web',
        externalUserId: 'd42f7a90-0000-4000-8000-000000000005',
        contactName: null,
        contactEmail: null,
        lastMessageAt: minutesAgo(17),
        lastMessageBody: '제휴 가게 쿠폰이 발급되지 않습니다',
        unread: false,
      },
      {
        id: 'demo-conv-2',
        source: 'web',
        externalUserId: 'b7c40d19-0000-4000-8000-000000000002',
        contactName: null,
        contactEmail: null,
        lastMessageAt: minutesAgo(22),
        lastMessageBody: '다크모드에서 코드 블록 테마가 깨져요',
        unread: false,
      },
      {
        id: 'demo-conv-3',
        source: 'web',
        externalUserId: '031a83d27853db2250ebac5d',
        contactName: null,
        contactEmail: null,
        lastMessageAt: minutesAgo(48),
        lastMessageBody: '예약할 때 날짜 바꾸면 인원수가 초기화돼요',
        unread: false,
        // 답변 지식에 없어서 AI 가 사람에게 넘긴 대화. 배지가 실제로 어떻게 보이는지 데모에 남긴다.
        escalated: true,
      },
    ],
    contexts: { 'demo-conv-4': { 'd4-1': DEMO_PICK_CONTEXT } },
    shots: { 'demo-conv-4': { 'd4-1': DEMO_PICK_SHOT } },
    timelines: {
      'demo-conv-1': [
        { id: 'd1-1', kind: 'user', body: '쿠폰 다운로드가 잘 안됩니다', at: minutesAgo(6) },
        { id: 'd1-2', kind: 'ai', body: '불편하셨겠어요. 「쿠폰 받기」가 안 되는 문제로 접수했어요. 원인은 짐작하지 않고 팀에 그대로 넘길게요 🙏', at: minutesAgo(6) },
      ],
      'demo-conv-4': [
        { id: 'd4-1', kind: 'user', body: '쿠폰 받기를 눌러도 아무 반응이 없어요', at: minutesAgo(11) },
        { id: 'd4-2', kind: 'ai', body: '불편하셨겠어요. 「쿠폰 받기」가 안 되는 문제로 접수했어요. 원인은 짐작하지 않고 팀에 그대로 넘길게요 🙏', at: minutesAgo(11) },
      ],
      'demo-conv-5': [
        { id: 'd5-1', kind: 'user', body: '제휴 가게 쿠폰이 발급되지 않습니다', at: minutesAgo(17) },
        { id: 'd5-2', kind: 'ai', body: '같은 제보가 몇 건 더 있어요. 「쿠폰 받기」 문제로 접수하고 팀에 그대로 넘길게요 🙏', at: minutesAgo(17) },
      ],
      'demo-conv-2': [
        { id: 'd2-1', kind: 'user', body: '다크모드에서 코드 블록 테마가 깨져요', at: minutesAgo(22) },
        { id: 'd2-2', kind: 'ai', body: '다크모드 스타일 충돌 확인했습니다. 수정 준비 중이에요.', at: minutesAgo(22) },
        { id: 'd2-3', kind: 'operator', body: '방금 반영했어요! 새로고침하고 한 번 봐주시겠어요?', at: minutesAgo(14) },
      ],
      'demo-conv-3': [
        { id: 'd3-1', kind: 'user', body: '예약할 때 날짜 바꾸면 인원수가 초기화돼요', at: minutesAgo(48) },
        { id: 'd3-2', kind: 'ai', body: '불편을 드려 죄송해요. 날짜 변경 시 인원이 초기화되는 문제 확인해볼게요!', at: minutesAgo(48) },
        // 방문자가 위젯의 「상담원 연결」을 누른 기록 (B2). 배지가 켜진 이유가 타임라인에 보인다.
        { id: 'd3-3', kind: 'notice', body: escalationNotice({ quote: '예약할 때 날짜 바꾸면 인원수가 초기화돼요', hasEmail: false, statusText: '보통 몇 분 안에 답해요' }), at: minutesAgo(46) },
        { id: 'd3-4', kind: 'system', body: '요청하신 "예약 인원 초기화" 가 반영됐어요. (PR #12)', at: minutesAgo(30) },
      ],
    },
  },

  classify: {
    insights: [
      { id: 'ins-1', classified_by: 'jev', classify_confidence: 0.96, category: 'bug', group_id: 'demo-group-1', summary: '「쿠폰 받기」를 눌러도 쿠폰이 발급되지 않음', sentiment: 'negative', follow_up_needed: true, created_at: minutesAgo(52), message_id: 'msg-1', messages: { body: '쿠폰 다운로드가 잘 안됩니다', author_name: '이수진', chat_id: 1001, source: 'web', detected_at: minutesAgo(52) } },
      { id: 'ins-1b', classified_by: 'jev', classify_confidence: 0.94, category: 'bug', group_id: 'demo-group-1', summary: '「쿠폰 받기」를 눌러도 쿠폰이 발급되지 않음', sentiment: 'negative', follow_up_needed: true, created_at: minutesAgo(47), message_id: 'msg-1b', messages: { body: '쿠폰 받기를 눌러도 아무 반응이 없어요', author_name: '방문자 #c1d0', chat_id: 1001, source: 'web', detected_at: minutesAgo(47) }, picked: DEMO_PICKED },
      { id: 'ins-1c', classified_by: 'jev', classify_confidence: 0.97, category: 'bug', group_id: 'demo-group-1', summary: '「쿠폰 받기」를 눌러도 쿠폰이 발급되지 않음', sentiment: 'negative', follow_up_needed: true, created_at: minutesAgo(44), message_id: 'msg-1c', messages: { body: '제휴 가게 쿠폰이 발급되지 않습니다', author_name: '방문자 #d42f', chat_id: 1001, source: 'web', detected_at: minutesAgo(44) } },
      { id: 'ins-2', classified_by: 'llm', classify_confidence: null, category: 'ux', group_id: 'demo-group-2', summary: '다크모드 코드 블록 테마 충돌', sentiment: 'negative', follow_up_needed: true, created_at: minutesAgo(40), message_id: 'msg-2', messages: { body: '다크모드에서 코드 블록 테마가 깨져요', author_name: '이프론트', chat_id: 1001, source: 'web', detected_at: minutesAgo(40) } },
      { id: 'ins-3', category: 'bug', group_id: null, summary: '401 인증 루프 — 세션 만료 후 무한 리다이렉트', sentiment: 'negative', follow_up_needed: true, created_at: minutesAgo(28), message_id: 'msg-3', messages: { body: '401 에러 후 무한 리다이렉트가 발생합니다', author_name: '임운영', chat_id: 1001, source: 'channel', detected_at: minutesAgo(28) } },
      { id: 'ins-4', category: 'feature_request', group_id: null, summary: 'Vercel 환경변수 자동 동기화 요청', sentiment: 'neutral', follow_up_needed: false, created_at: minutesAgo(15), message_id: 'msg-5', messages: { body: 'Vercel 환경변수 자동 동기화 기능 추가해주세요', author_name: '박데브', chat_id: 1001, source: 'web', detected_at: minutesAgo(15) } },
      { id: 'ins-5', category: 'praise', group_id: null, summary: '빠른 버그 대응에 대한 칭찬', sentiment: 'positive', follow_up_needed: false, created_at: minutesAgo(9), message_id: 'msg-6', messages: { body: '와 진짜 5분만에 고쳐졌네요 소름 돋습니다', author_name: '최유저', chat_id: 1001, source: 'web', detected_at: minutesAgo(9) } },
      { id: 'ins-6', category: 'cs', group_id: null, summary: '프로 플랜 결제 관련 문의', sentiment: 'neutral', follow_up_needed: true, created_at: minutesAgo(4), message_id: 'msg-7', messages: { body: '프로 플랜 결제했는데 기능이 안 열려요', author_name: '유프로', chat_id: 1001, source: 'web', detected_at: minutesAgo(4) } },
    ],
  },

  monitor: {
    // 수정 PR 목록 — /api/auto-dev/runs 의 RunItem 모양. 되돌림(returns)까지 한 실행에 붙는다.
    runs: [
      {
        id: 'demo-run-1', status: 'completed', createdAt: minutesAgo(46), durationMs: 47200,
        title: '「쿠폰 받기」를 눌러도 쿠폰이 발급되지 않음', category: 'bug', repo: 'example/feedloop-demo',
        pr: { url: 'https://github.com/example/feedloop-demo/pull/128', number: 128, mergedAt: minutesAgo(12), closedAt: minutesAgo(12), closeReason: null, closeNote: null },
        filesChanged: [
          { path: 'app/components/PartnerCoupon.tsx', action: 'modified' },
          { path: 'app/lib/coupon/issue.ts', action: 'modified' },
        ],
        errorMessage: null,
        evidence: { insightCount: 3, conversationCount: 3 },
        demoPickedShots: [DEMO_PICKED],
        returns: [
          { conversationId: 'demo-conv-1', source: 'web', name: '이수진', deliveredAt: minutesAgo(8), confirmation: 'fixed', confirmedAt: minutesAgo(5) },
          { conversationId: 'demo-conv-2', source: 'web', name: '방문자 #b7c4', deliveredAt: minutesAgo(8), confirmation: null, confirmedAt: null },
          { conversationId: 'demo-conv-3', source: 'web', name: '방문자 #031a', deliveredAt: null, confirmation: null, confirmedAt: null },
        ],
      },
      {
        id: 'demo-run-2', status: 'completed', createdAt: minutesAgo(35), durationMs: 61000,
        title: '다크모드 코드 블록 테마 충돌', category: 'ux', repo: 'example/feedloop-demo',
        pr: { url: 'https://github.com/example/feedloop-demo/pull/129', number: 129, mergedAt: null, closedAt: null, closeReason: null, closeNote: null },
        filesChanged: [{ path: 'src/components/CodeBlock.tsx', action: 'modified' }],
        errorMessage: null,
        evidence: { insightCount: 2, conversationCount: 2 },
        returns: [],
      },
      {
        id: 'demo-run-3', status: 'failed', createdAt: minutesAgo(20), durationMs: 21000,
        title: '관광지 사진이 늦게 뜬다', category: 'ux', repo: 'example/feedloop-demo',
        pr: null, filesChanged: [],
        errorMessage: '수정 대상 파일을 찾지 못했습니다',
        evidence: { insightCount: 1, conversationCount: 1 },
        returns: [],
      },
    ],
    lines: [
      // 줄거리는 각본(쿠폰)을 따르고, 말투는 main 의 문구 정책(「저장소」·「수정안」)을 따른다
      { type: 'log', message: '자동 수정 시작...' },
      { type: 'log', message: '묶음 "「쿠폰 받기」를 눌러도 쿠폰이 발급되지 않음" 으로 수정안을 만듭니다' },
      { type: 'log', message: '저장소 파일 트리 조회 중...' },
      { type: 'log', message: 'AI에 수정 대상 파일 선정 요청 중...' },
      { type: 'log', message: '수정 대상 선정: app/components/PartnerCoupon.tsx' },
      { type: 'log', message: 'AI에 코드 수정안 요청 중...' },
      { type: 'log', message: '수정 경로 검증 중...' },
      { type: 'log', message: '수정안 만드는 중...' },
      { type: 'complete', message: 'PR #128 생성 완료!' },
    ],
  },

  bots: {
    bots: [
      { id: 'demo-bot-1', service_name: 'rona.so 피드백봇', bot_username: '@rona_feedback_bot', service_description: 'rona.so 커뮤니티 피드백 수집 및 AI 분류', status: 'active', created_at: '2026-03-25T09:00:00Z' },
      { id: 'demo-bot-2', service_name: 'Feedloop 테스트봇', bot_username: '@feedloop_test_bot', service_description: '개발/테스트용 봇', status: 'pending', created_at: '2026-03-27T14:00:00Z' },
    ],
  },

  botsNew: {},
};
