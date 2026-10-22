#!/usr/bin/env python3
"""Builds the English demo screen copies from the Korean ones.

Usage: python3 -I scripts/localize-demo-html.py public/demo
Reads public/demo/<screen>/index.ko.html and writes index.html (English) next to it.
The Korean copies come from the capture scripts (capture-nulnul.mjs, render-demo-mail.ts); re-run this
after re-capturing. Any Hangul it could not map is printed as LEFT - the demo test fails on it too."""
import re, sys, os

ROOT = sys.argv[1]  # .../public/demo

NAMES = {
    '이수진': ('Emily Carter', 'E'),
    '이프론트': ('Daniel Park', 'D'),
    '임운영': ('Olivia Reed', 'O'),
    '박데브': ('Ben Miller', 'B'),
    '최유저': ('Chloe Lin', 'C'),
}

CITIES = {
    '인천': 'Incheon', '수원': 'Suwon', '춘천': 'Chuncheon', '청주': 'Cheongju', '세종': 'Sejong',
    '대전': 'Daejeon', '대구': 'Daegu', '포항': 'Pohang', '울산': 'Ulsan', '광주': 'Gwangju',
    '여수': 'Yeosu', '목포': 'Mokpo',
    '경주': 'Gyeongju', '제주시': 'Jeju City', '서귀포시': 'Seogwipo', '강릉': 'Gangneung',
    '통영': 'Tongyeong', '속초': 'Sokcho', '안동': 'Andong', '부산 해운대': 'Busan Haeundae',
    '전주 완산구': 'Jeonju Wansan', '서울 종로': 'Seoul Jongno',
}

M = {
    # ── Feedloop team screens: chrome ──
    'Feedloop — 고객 피드백이 들어오는 즉시 수정이 시작되고, 완료되면 자동으로 알립니다': 'Feedloop — Turn customer feedback into reviewed fix PRs',
    '고객 피드백이 들어오는 즉시 수정이 시작되고, 완료되면 보낸 분께 자동으로 알립니다. 설치는 5분이면 끝납니다.': 'Feedloop sorts customer feedback, opens a fix pull request for you to review, and tells the sender when it ships. Setup takes five minutes.',
    '대시보드': 'Dashboard', '대화': 'Inbox', '피드백': 'Feedback', '수정안': 'Fix PRs', '연결 서비스': 'Bots',
    'Google로 시작': 'Sign in with Google',
    '예시 데이터 · 로그인 없이 둘러보기': 'Sample data · browse without logging in',
    '예시 데이터로 둘러보는 중이에요. 모든 메뉴를 로그인 없이 볼 수 있어요.': 'You are browsing sample data. Every menu is open without logging in.',
    # ── team-inbox ──
    '답장을 기다리는 대화 ': 'Waiting for a reply ',
    '1건': '1', '2건': '2', '· 안 읽음': '· Unread',
    '안 읽음': 'Unread', '전체': 'All',
    '웹 위젯': 'Web widget', '채널톡': 'Channel Talk',
    '읽지 않음': 'Unread',
    '담당자 확인 필요': 'Needs reply',
    '대화 목록': 'Conversation list', '대화 상세': 'Conversation detail',
    '대화 닫기': 'Close conversation',
    '닫으면 되돌릴 수 없어요.': "Closing can't be undone.",
    '쿠폰 다운로드가 잘 안됩니다': "The coupon download isn't working",
    '쿠폰 받기를 눌러도 아무 반응이 없어요': 'Tapping Get coupon does nothing',
    '제휴 가게 쿠폰이 발급되지 않습니다': "Partner shop coupons won't issue",
    '다크모드에서 코드 블록 테마가 깨져요': 'Code blocks look broken in dark mode',
    '예약할 때 날짜 바꾸면 인원수가 초기화돼요': 'Changing the date while booking resets the guest count',
    '방문자 · 오후 9:38': 'Visitor · 9:38 PM',
    'AI 응답 · 오후 9:38': 'AI reply · 9:38 PM',
    '불편하셨겠어요. 「쿠폰 받기」가 안 되는 문제로 접수했어요. 원인은 짐작하지 않고 팀에 그대로 넘길게요 🙏': "Sorry about that. I've logged this as a problem with “Get coupon.” I won't guess at the cause, so I'm passing it to the team as is 🙏",
    '답장을 입력하세요': 'Type a reply', '보내기': 'Send',
    '답장은 위젯에 바로 전달되고, emily@example.com 로도 메일이 갑니다.': 'Your reply goes to the widget right away, and an email goes to emily@example.com too.',
    # ── team-groups ──
    '루프 대시보드': 'Loop dashboard',
    '반영됐는지 확인': 'Check for shipped fixes',
    'AI 분류 실행': 'Run AI triage',
    '루프 단계': 'Loop stages',
    '들어온 피드백': 'Incoming feedback',
    'AI 가 분류': 'AI triage',
    '분류 상태 상세 미확인': 'Classification detail unavailable',
    '반영 1': 'Shipped 1',
    '반영 알림': 'Notification',
    '4명에게 「반영됐어요」가 돌아갔어요': '“Fixed” sent to 4 people',
    '제보 → 반영 알림 평균': 'Avg. time from report to notification',
    '2.4일': '2.4 d',
    '반영 알림 4건 기준': 'Based on 4 notifications',
    '「네, 잘 돼요」 비율': '“Yes, it works” rate',
    '웹 위젯 기준 · 답한 3건 중 2건 · 응답률 75%': 'Web widget only · 2 of 3 answered · response rate 75%',
    '피드백 묶음': 'Feedback groups',
    '같은 문제를 말한 사람들을 수정안 하나로 묶습니다. 제보 뒤 1~2분이면 저절로 묶여요.': 'People who raised the same problem are bundled into one fix PR. A group forms by itself 1–2 minutes after a report.',
    '2건이 아직 안 묶였어요': '2 items are not grouped yet',
    '지금 묶기': 'Group now',
    '버그': 'Bug',
    '「쿠폰 받기」를 눌러도 쿠폰이 발급되지 않음': "Tapping “Get coupon” doesn't issue a coupon",
    '전국 지도에서 제휴 가게의 「쿠폰 받기」를 눌러도 쿠폰이 받아지지 않는다는 제보. 모바일·PC 모두에서 보고됨.': 'Reports that tapping “Get coupon” on a partner shop on the Korea map does not issue a coupon. Seen on both mobile and desktop.',
    '35분 전': '35 min ago', '41분 전': '41 min ago', '46분 전': '46 min ago', '20분 전': '20 min ago',
    '6분 전': '6 min ago', '11분 전': '11 min ago', '17분 전': '17 min ago', '22분 전': '22 min ago', '48분 전': '48 min ago',
    '3분 전': '3 min ago', '14분 전': '14 min ago', '27분 전': '27 min ago', '39분 전': '39 min ago',
    '반영됨': 'Shipped',
    'PR #128 보기': 'View PR #128',
    '다크모드에서 코드 블록 테마가 깨짐': 'Code block theme breaks in dark mode',
    '다크모드 전환 시 코드 블록 배경과 글자색이 겹쳐 읽을 수 없다는 제보.': 'Reports that after switching to dark mode, the code block background and text color overlap and can’t be read.',
    '수정안 만들기': 'Create fix PR',
    '이 묶음 닫기': 'Close this group', '닫기': 'Close',
    '채널에서 들어온 피드백': 'Feedback from your channels',
    '대화에서 답장': 'Reply in Inbox',
    '오후 8:52': '8:52 PM', '오후 8:57': '8:57 PM', '오후 9:00': '9:00 PM', '오후 9:04': '9:04 PM',
    '오후 9:16': '9:16 PM', '오후 9:29': '9:29 PM',
    'AI 답변 보냄': 'AI replied', '반영 알림 보냄': 'Notification sent',
    '401 에러 후 무한 리다이렉트가 발생합니다': 'After a 401 error the page redirects forever',
    '답변 대기': 'Waiting for a reply',
    'Vercel 환경변수 자동 동기화 기능 추가해주세요': 'Please add automatic Vercel environment variable sync',
    '피드백 채널': 'Feedback channels',
    '권장 입구 · 스크립트 한 줄': 'Recommended channel · one script line',
    '연결됨': 'Connected',
    '선택 채널 · 상담 웹훅': 'Optional channel · support webhook',
    '아직 안 붙음': 'Not connected yet',
    '연결하기': 'Connect',
    '루프에서 일어난 일': 'What happened in the loop',
    'AI 분류': 'AI triage',
    '· 빠른 버그 대응에 대한 칭찬': '· Praise for a fast bug fix',
    '· Vercel 환경변수 자동 동기화 요청': '· Request: automatic Vercel environment variable sync',
    '수정안 만듦': 'Fix PR created',
    '· PR #128 자동 생성': '· PR #128 created automatically',
    '· 401 인증 루프 — 세션 만료 후 무한 리다이렉트': '· 401 auth loop — endless redirect after the session expires',
    '· 다크모드 코드 블록 테마 충돌': '· Dark mode code block theme conflict',
    '수정안 모드 · 승인.': 'Fix PR mode: you approve each PR.',
    '수정안은 만들어두고 반영은 사람이 합니다. 반영이 확인되면 그 문제를 말한 사람 모두에게 반영 알림이 나갑니다.': 'Fix PRs are prepared and a person ships them. Once a fix is confirmed shipped, everyone who raised that problem gets a notification.',
    # ── team-pr ──
    '검토를 기다리는 수정안 ': 'Fix PRs waiting for review ',
    '1개': '1',
    'AI 가 만든 코드 수정안입니다 · GitHub 에서는 Pull request(PR) 로 열려요': 'Code fixes written by AI · they open as pull requests (PRs) on GitHub',
    '검토 대기': 'Awaiting review', '실패': 'Failed',
    '더보기 3': 'Show 3 more',
    'PR #128 · 47초 · 파일 2개': 'PR #128 · 47s · 2 files',
    '다크모드 코드 블록 테마 충돌': 'Dark mode code block theme conflict',
    'PR #129 · 61초 · 파일 1개': 'PR #129 · 61s · 1 file',
    '관광지 사진이 늦게 뜬다': 'Attraction photos load slowly',
    '수정 대상 파일을 찾지 못했습니다 · 21초': "Couldn't find the file to change · 21s",
    'GitHub 에서 PR #128 보기': 'View PR #128 on GitHub',
    '실행 검증': 'Run check',
    '실행 검증 미확인': 'Run check unconfirmed',
    'PR 생성': 'PR created', '생성됨': 'Created',
    '배포 확인': 'Deploy check', '배포 미확인': 'Deploy unconfirmed',
    '사용자 확인': 'User confirmation', '해결 확인 대기': 'Waiting for confirmation',
    '근거 피드백': 'Supporting feedback',
    '건': 'items', '명': 'people',
    '프리뷰': 'Preview',
    '반영됨 · 배포는 따로 확인': 'Shipped · deploy is checked separately',
    '반영 뒤 프리뷰가 제공되는지는 배포 서비스에 따라 달라요': 'Whether a preview is available after shipping depends on your deploy service',
    '빌드': 'Build',
    '이 수정이 하는 일': 'What this fix does',
    'AI 가 코드를 고치면서 쓴 설명이에요': 'Description written by the AI while fixing the code',
    '이 수정안에는 설명이 없어요. 아래 「바뀐 코드」와 GitHub 의 PR 본문을 봐 주세요.': 'This fix PR has no description. See “Changed code” below and the PR body on GitHub.',
    '바뀐 코드': 'Changed code',
    '개발자용 · 파일을 눌러 펼치기': 'For developers · click a file to expand',
    'AI 코드 판단은 참고 의견입니다. 실제 실행 검증 결과는 위 검사 기록에서 확인하세요.': 'The AI code review is an opinion only. See the check record above for actual run results.',
    '소요': 'Took',
    '47초 · 9월 18일 오후 8:58 시작': '47s · started Sep 18, 8:58 PM',
    '반영': 'Shipped',
    '9월 18일 오후 9:32 · 반영 알림 2건이 오후 9:36 에 나갔어요': 'Sep 18, 9:32 PM · 2 notifications went out at 9:36 PM',
    '반영됐다고 알립니다. 배포와 문제 해결은 따로 확인합니다': 'Tells people the fix shipped. Deploy and resolution are confirmed separately',
    '전달됨': 'Delivered',
    '· 오후 9:36': '· 9:36 PM',
    '네, 잘 돼요': 'Yes, it works',
    '응답 없음': 'No answer',
    '대기 · 다음에 말을 걸 때 전달': 'Waiting · delivered the next time they message',
    '전달 전': 'Not delivered',
    '카카오톡 대화는 상대가 다음에 말을 걸 때 답변 앞에 붙어 갑니다. 「아직 그대로예요」는 대화 탭에서 이어서 봅니다.': 'KakaoTalk can’t start a conversation, so the notice goes out with your next reply after they message you. For “Still broken”, continue in the Inbox tab.',
    '실행 로그': 'Run log',
    '자동 수정 시작...': 'Starting auto-fix...',
    '저장소 파일 트리 조회 중...': 'Reading the repository file tree...',
    'AI에 수정 대상 파일 선정 요청 중...': 'Asking the AI which file to change...',
    '수정 대상 선정: app/components/PartnerCoupon.tsx': 'Selected file: app/components/PartnerCoupon.tsx',
    'AI에 코드 수정안 요청 중...': 'Asking the AI for a code fix...',
    '수정 경로 검증 중...': 'Checking the file paths...',
    '수정안 만드는 중...': 'Creating the fix PR...',
    'PR #128 생성 완료!': 'PR #128 created!',
    '실제 실행 결과는 위 검사 기록에서 확인하세요. 기록이 없으면 검증 미확인입니다. 반영, 배포, 사용자 해결 확인은 각각 다른 단계입니다.': 'See the check record above for actual run results. With no record, the check is unconfirmed. Shipping, deploying and user confirmation are separate steps.',
    '묶음': 'Group',
    # ── mail ──
    '[널널투어] 말씀하신 문제를 고쳤어요': '[Wander Korea] We fixed the problem you reported',
    '널널투어': 'Wander Korea',
    '이수진 님, 말씀하신 문제를 고쳤어요.': 'Emily, we fixed the problem you reported.',
    '고친 내용': 'What changed',
    '고친 시각': 'Fixed at',
    '2026년 9월 18일 22:16': 'Sep 18, 2026, 10:16 PM',
    '변경 내역': 'Change log',
    '바뀐 내용 보기 →': 'See what changed →',
    '같은 내용을 대화 창에서도 볼 수 있어요.': 'You can see the same message in the chat window.',
    '01 · 고친 내용': '01 · WHAT CHANGED',
    '무엇이 바뀌었나요': 'What changed',
    '02 · 확인해 주세요': '02 · PLEASE CHECK',
    '직접 써보고 알려주세요': 'Try it and let us know',
    '✅ 잘 되는지 한 번만': '✅ One quick check',
    '바뀐 화면을 직접 확인해 보시고, 아직 그대로라면 같은 대화 창에서 알려주세요.': 'Take a look at the updated screen. If it is still the same, tell us in the same chat window.',
    '담당자가 바로 다시 봅니다. 잘 된다는 한마디도 큰 힘이 돼요.': 'The owner will look again right away. A quick “it works” helps too.',
    '널널투어 에서 확인하기 →': 'Check it on Wander Korea →',
    '본 메일은 널널투어 에 남기신 피드백의 처리 결과입니다. · Feedloop 이 대신 보냈어요': 'You are receiving this because you left feedback on Wander Korea. · Sent by Feedloop on behalf of Wander Korea',
    # ── nulnul-map ──
    '전국 지도 | 널널투어': 'Korea map | Wander Korea',
    '서비스 중인 지역과 준비 중인 도시를 전국 지도 한 장에서 확인해요.': 'See the regions we serve and the cities coming soon on one map of Korea.',
    '주요 메뉴': 'Main menu', '홈': 'Home', '쿠폰': 'Coupons', '전국 지도': 'Korea map',
    '언어 선택': 'Language',
    '로그인': 'Log in', '구글로 계속하기': 'Continue with Google',
    '로그인 전에 받은 쿠폰도 계정에 함께 보관돼요': 'Coupons you claimed before logging in are saved to your account too',
    '지역을 누르면 그곳 관광지의 오늘 등급과 쿠폰이 펼쳐집니다 · 10곳 서비스 중': "Tap a region to see today's crowd level and coupons for its attractions · 10 regions live",
    '대한민국 전국 지도 — 서비스 중인 10개 지역과 준비 중인 12개 도시': 'Map of South Korea — 10 regions live, 12 cities coming soon',
    '제주 · 실제보다 가까이 그림': 'Jeju (shown closer than it really is)',
    '보고 있는 지역': 'Selected region',
    '서비스 중 10곳': '10 live', '준비 중 12곳': '12 coming soon',
    '서울 종로 패널': 'Seoul Jongno panel',
    '서비스 중': 'Live',
    '관광지 5곳': '5 attractions',
    '오늘 받을 수 있는 쿠폰 11장': '11 coupons available today',
    '제휴 가게 7곳': '7 partner shops',
    '관광지': 'Attractions',
    '오늘 예측 · 한산한 순': "Today's forecast · quietest first",
    '경복궁': 'Gyeongbokgung Palace',
    '조선의 법궁으로, 수문장 교대 의식을 볼 수 있어요.': 'The main palace of the Joseon dynasty, with a royal guard changing ceremony.',
    '서울 종로구 사직로 161': '161 Sajik-ro, Jongno-gu, Seoul',
    '한산': 'Quiet', '보통': 'Moderate',
    '쿠폰 4': '4 coupons', '쿠폰 3': '3 coupons', '쿠폰 2': '2 coupons', '쿠폰 1': '1 coupon',
    '북촌한옥마을': 'Bukchon Hanok Village',
    '전통 한옥이 밀집한 마을로, 골목 산책과 전망 포인트가 있어요.': 'A village packed with traditional hanok houses, with alley walks and viewpoints.',
    '서울 종로구 계동길 37': '37 Gyedong-gil, Jongno-gu, Seoul',
    '운현궁': 'Unhyeongung Palace',
    '흥선대원군의 사저였던 궁으로, 도심 속 고즈넉한 산책지예요.': 'The former residence of Heungseon Daewongun, a quiet place to stroll in the middle of the city.',
    '서울 종로구 삼일대로 464': '464 Samil-daero, Jongno-gu, Seoul',
    '덕수궁': 'Deoksugung Palace',
    '대한제국의 궁궐로, 돌담길 산책과 야간 개장이 알려져 있어요.': 'An imperial palace of the Korean Empire, known for its stone-wall walk and night openings.',
    '서울 중구 세종대로 99': '99 Sejong-daero, Jung-gu, Seoul',
    '전체 보기': 'View all',
    '받을 수 있는 쿠폰': 'Available coupons',
    '제휴 가게 7곳 · 오늘 받을 수 있는 쿠폰 11장': '7 partner shops · 11 coupons available today',
    '쿠폰 모아보기': 'Browse all coupons',
    '한옥찻집 소슬': 'Soseul Hanok Teahouse',
    '경복궁 근처': 'Near Gyeongbokgung',
    '쌍화차 1+1 (2인 방문 시)': 'Buy one get one free on ssanghwa tea (parties of 2)',
    '1월 4일 (월)': 'Jan 4 (Mon)',
    '쿠폰 받기': 'Get coupon',
    '대추차 주문 시 약과 2개 서비스': 'Two free yakgwa cookies with a jujube tea',
    '1월 12일 (화)': 'Jan 12 (Tue)',
    '궁중다과점 연리': 'Yeonri Royal Sweets Shop',
    '궁중 다과 세트 10% 할인': '10% off the royal sweets set',
    '사진관 온재': 'Onjae Photo Studio',
    '북촌한옥마을 근처': 'Near Bukchon Hanok Village',
    '2인 촬영 시 액자 인화 1장 무료': 'One free framed print for shoots of 2',
    '한복 스냅 촬영 20% 할인': '20% off hanbok snap shoots',
    '북촌수제만두': 'Bukchon Handmade Dumplings',
    '만둣국 주문 시 군만두 2개 서비스': 'Two free fried dumplings with a dumpling soup',
    '1월 11일 (월)': 'Jan 11 (Mon)',
    '더보기': 'Show more',
    '시범 데이터 가게와 쿠폰이 섞여 있어요. 시범 가게의 사진은 AI 생성 시범 이미지예요.': 'Sample shops and coupons are mixed in. Photos of sample shops are AI-generated sample images.',
    '쿠폰을 받았어요': 'Coupon claimed',
    '내 쿠폰함 보기': 'View my coupons',
    '계속 둘러보기': 'Keep browsing',
}
for ko, (en, _) in NAMES.items():
    M[ko] = en
for ko, en in CITIES.items():
    M[ko] = en
    M[f'{ko} — 준비 중'] = f'{en} — coming soon'
    M[f'{ko} — 서비스 중'] = f'{en} — live'

# raw / regex passes (before exact mapping)
RAW = [
    ('피드백 <strong class="tabular-nums">47건</strong>을 받았고, 반영 알림을 <strong class="tabular-nums">4건</strong> 전달했어요.',
     '<strong class="tabular-nums">47 feedback items</strong> received · <strong class="tabular-nums">4 notifications</strong> sent'),
    ('<option value="ko" selected="">한국어</option><option value="en">English</option>',
     '<option value="ko">Korean</option><option value="en" selected="">English</option>'),
    ('<html lang="ko"', '<html lang="en"'),
    ('FEEDBACK APPLIED', 'FIX SHIPPED'),
    # 영어판은 실제 가게 주소(nulnul.vercel.app) 대신 예약 도메인을 보여 준다(2026-10-21 ny: 영어 시연 가게는 Wander Korea)
    ('nulnul.vercel.app', 'wanderkorea.example'),
]


def tr(s: str) -> str:
    for a, b in RAW:
        s = s.replace(a, b)
    s = re.sub(r'피드백 (<b[^>]*>\d+</b>)건', r'Feedback \1', s)
    # 근거 피드백 칸: `3건 · 3명` → `3 items from 3 people` (앱의 monitor.review.facts 와 같은 말)
    s = re.sub(r'(\d+)<small([^>]*)>건</small><span([^>]*)>·</span>(\d+)<small([^>]*)>명</small>',
               r'\1<small\2> items</small><span\3>from</span>\4<small\5> people</small>', s)
    s = re.sub(r'(</b>)명이 말했어요', r'\1 people raised it', s)
    s = s.replace('묶음 "「쿠폰 받기」를 눌러도 쿠폰이 발급되지 않음" 으로 수정안을 만듭니다',
                  'Creating a fix PR for the group "Tapping “Get coupon” doesn\'t issue a coupon"')
    # avatar initials follow the name that comes right after them
    for ko, (en, ini) in NAMES.items():
        s = re.sub(r'>[가-힣]</span>(?=(?:<[^>]+>){1,3}' + re.escape(ko) + r'<)', f'>{ini}</span>', s)
    s = re.sub(r'>[가-힣]</span>(?=(?:<[^>]+>){1,3}방문자 #)', '>V</span>', s)
    s = re.sub(r'방문자 #([0-9a-f]{4})', r'Visitor #\1', s)

    def node(m):
        pre, txt, post = m.group(1), m.group(2), m.group(3)
        core = txt.strip()
        if core in M:
            lead = txt[: len(txt) - len(txt.lstrip())]
            trail = txt[len(txt.rstrip()):]
            return pre + lead + M[core] + trail + post
        if txt in M:
            return pre + M[txt] + post
        return m.group(0)

    s = re.sub(r'(>)([^<>]*[가-힣][^<>]*)(<)', node, s)

    def attr(m):
        v = m.group(2)
        return m.group(1) + (M[v] if v in M else v) + m.group(3)

    s = re.sub(r'(="|=\')([^"\']*[가-힣][^"\']*)("|\')', attr, s)
    return s


for d in ['mail', 'team-inbox', 'team-groups', 'team-pr', 'nulnul-map']:
    src = os.path.join(ROOT, d, 'index.ko.html')
    s = open(src, encoding='utf8').read()
    # specific compound sentences first (they contain mapped words)
    s = s.replace('남겨주신 피드백대로 널널투어 를 고쳤어요. 서비스에 반영되기까지는 조금 더 걸릴 수 있어요.<br>알려주셔서 고마워요 — 잘 되는지 대화 창에서 알려주세요.',
                  'We changed Wander Korea based on the feedback you left. It may take a few more minutes to appear on the live site.<br>Thanks for telling us — let us know in the chat window if it works.')
    s = s.replace('보낸사람 <b style="color:#191d1b">널널투어</b> · 받는사람 sujin@example.com',
                  'From <b style="color:#191d1b">Wander Korea</b> · To emily@example.com')
    s = s.replace('sujin@example.com', 'emily@example.com')
    s = tr(s)
    left = sorted(set(re.findall(r'[^<>"]*[가-힣][^<>"]*', s)))
    out = os.path.join(ROOT, d, 'index.html')
    open(out, 'w', encoding='utf8').write(s)
    print(d, 'hangul left:', len(re.findall('[가-힣]', s)))
    for x in left:
        print('   LEFT', repr(x.strip()))
