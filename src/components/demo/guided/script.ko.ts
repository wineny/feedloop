import type { ScriptCopy } from './script';

/**
 * 한국어판 각본 문구 — 원래 각본(2026-09-18, ny)을 그대로 옮겼다.
 * 떠 온 화면(`public/demo/<화면>/index.ko.html`)의 글자와 한 글자도 같아야 한다.
 */
export const copy: ScriptCopy = {
  hello: '안녕하세요! 널널투어예요. 쿠폰이나 예약에서 불편한 점 있으면 편하게 남겨주세요.',
  // ny 가 직접 정한 문장(2026-09-18)
  report: '쿠폰 다운로드가 잘 안됩니다',
  // 모르는 것을 지어내지 않는다 — 원인을 단정하지 않고 「팀에 넘겼다」로 끝낸다(`src/lib/bot/holding.ts`)
  reply:
    '불편하셨겠어요. 「쿠폰 받기」가 안 되는 문제로 접수했어요. 원인은 제가 짐작하지 않고 팀에 그대로 넘길게요 — 고쳐지면 이 대화창으로 알려드릴게요.',
  fixed: '말씀하신 쿠폰 받기, 고쳐서 올렸어요. 이제 제휴 가게 쿠폰이 바로 받아집니다.',
  groupTitle: '「쿠폰 받기」를 눌러도 쿠폰이 발급되지 않음',
  similar: ['쿠폰 다운로드가 잘 안됩니다', '쿠폰 받기를 눌러도 아무 반응이 없어요', '제휴 가게 쿠폰이 발급되지 않습니다'],
  couponButton: '쿠폰 받기',
  prLines: ['GitHub 에서 PR #128 보기', 'PR #128 · 47초 · 파일 2개'],
  recipients: ['이수진', '방문자 #b7c4'],
  delivered: '전달됨',
  mailSubject: '[널널투어] 말씀하신 문제를 고쳤어요',
  urls: {
    map: 'nulnul.vercel.app/nationwide',
    inbox: 'ai-feedloop.vercel.app/inbox',
    groups: 'ai-feedloop.vercel.app/dashboard',
    pr: 'ai-feedloop.vercel.app/monitor',
    mail: 'sujin@example.com 의 메일함',
  },
  steps: {
    open: { title: '오른쪽 아래 챗봇 버튼', short: '챗봇 열기', hint: '이 버튼을 눌러보세요' },
    write: { title: '불편한 점을 그대로 씁니다', short: '불편한 점 한마디 남기기', hint: '입력칸을 눌러보세요' },
    tool: { title: '말로 옮기지 않아도 됩니다', short: '화면에서 선택하기 켜기', hint: '여기를 눌러보세요' },
    point: { title: '문제가 있는 부분을 그대로 집어요', short: '문제 지점 직접 집기', hint: '안 되는 버튼을 집어보세요' },
    arrive: {
      title: '같은 순간, 팀의 편지함',
      short: '팀 편지함에 도착·분류',
      hint: '',
      say: '사용자가 남긴 피드백',
      label: '같은 말을 한 사람이 또 있는지 볼게요',
    },
    similar: {
      title: '같은 말을 한 사람이 또 있었습니다',
      short: '비슷한 제보 찾기',
      hint: '이 셋이 같은 문제예요',
      label: '이 셋이 어떻게 묶이는지 볼게요',
    },
    group: {
      title: '한 묶음이 되면 넘기기 어려워집니다',
      short: '한 묶음으로 묶기',
      hint: '',
      say: '하나의 피드백으로 묶입니다',
      label: '이 묶음이 코드로 가는 걸 볼게요',
    },
    pr: {
      title: '고치는 초안까지 AI 가 씁니다',
      short: 'AI 가 수정안 만들기',
      hint: '',
      say: 'AI가 자동으로 개선해 승인을 요청해요',
      label: '사람이 할 일이 뭔지 볼게요',
    },
    merge: {
      title: '사람이 하는 일은 하나 — 반영 여부',
      short: '반영은 사람이 결정',
      hint: '',
      say: '피드백 준 유저에게 자동으로 전달돼요',
      label: '반영하고, 보낸 사람에게 알릴게요',
    },
    returned: {
      title: '보낸 말이 대화창으로 돌아옵니다',
      short: '대화창에 「반영됐어요」',
      hint: '반영 내용은 채팅으로도 전달됩니다',
    },
    mail: {
      title: '메일로도 한 번 더 갑니다',
      short: '메일함에도 도착',
      hint: '',
      say: '이메일로도 전달됩니다',
      label: '여기까지가 한 바퀴예요',
    },
  },
};
