/**
 * 「FAQ」 섹션 — 붙이는 법 다음, 마지막 CTA 띠 바로 앞. 흰 지면의 마지막 블록이다.
 *
 * 자리를 두 번 옮긴 끝이다(2026-09-18). CTA «앞» → CTA «뒤» → 다시 «앞». 마지막 판단은
 * CTA 가 코랄 띠가 되면서 났다 — 띠가 페이지를 닫는 면이 됐으니 그 앞이 본문의 끝이고,
 * FAQ 는 본문의 마지막 말이다. 망설이는 사람이 답을 찾고 곧바로 띠의 버튼을 만난다.
 *
 * ⚠️ 아래 여백은 **일부러 없다** — `FinalCTA` 띠의 `marginTop` 이 그 몫이다. 둘 다 주면
 *    `--space-section` 이 두 번 쌓인다. 순서를 바꾸면 두 파일을 같이 본다.
 *
 * ⚠️ 위 섹션이 이미 한 말을 되풀이하지 않는다. FAQ 는 랜딩이 «말하지 않고 남겨둔»
 *    의심을 채우는 자리다. 그래서 「반영은 고객이 어떻게 아나요」는 뺐다 —
 *    `HowItWorks` 4단계 「반영 알림」이 같은 말을 한다.
 *
 * ⚠️ 핵심은 03 이다. 이 랜딩에서 운영자에게 가장 무서운 문장이 「저장소를 읽고 수정안을
 *    코드로 써서 PR 을 올립니다」라, 여기서 «남이 내 레포에 손대는 게 아니다»를 못 세우면
 *    CTA 를 안 누른다. 순서를 바꾸더라도 이건 위쪽에 둔다.
 *
 * ⚠️ 「고객이 아무 말이나 남겨도 PR 이 열리나요」는 **일부러 뺐다**(ny 판단 2026-09-18).
 *    자동 모드의 문턱(서로 다른 대화 2개·익명 묶음 제외·봇당 하루 1건)을 랜딩에서 약속처럼
 *    적었는데 실제와 맞지 않았다. 다시 넣으려면 `lib/auto-dev/auto-pr.ts` 의 지금 동작부터
 *    확인하고 쓴다 — 랜딩이 코드보다 앞서 말하면 안 된다.
 *
 * ⚠️ 05(가격)는 랜딩에서 무료를 말하는 **유일한 자리**다. 히어로 받침 문구
 *    「하루 100건 무료 · 신용카드 없이」를 뺐을 때(9/18) 그 사실을 말할 데가 없어졌다.
 *
 * ⚠️ 접기는 `<details>` 다 — JS 없이 열리고 닫힌다. 랜딩의 다른 블록과 마찬가지로
 *    좌측 테두리 카드는 쓰지 않는다(AI 티 패턴, ny 지시). 행을 가르는 건 가로선 하나다.
 *
 * ⚠️ 답에 적힌 숫자·권한은 실제 동작과 묶여 있다. 고치기 전에 아래를 본다 —
 *      「하루 100건」  `lib/llm/limits.ts` DEFAULT_LIMITS.noKey
 *      「권한 둘」     `Plans.tsx` 03 단계와 같은 말이어야 한다
 *      「어디까지 전달」 `public/widget-pick.js` describe·skeleton + `lib/widget/context.ts` sanitizeTarget
 *                      (2026-09-23 추가 — 고객사 질문. 봇 지식 FAQ 에도 같은 답이 있다)
 */
import { SectionHead } from './SectionHead';

interface Qa {
  q: string;
  /** 두세 문장. 길어지면 접힌 걸 펴는 값이 사라진다. */
  a: string;
}

const items: Qa[] = [
  {
    q: '운영 중인 챗봇이 없는데, 피드백을 어떻게 받나요?',
    a: '피드루프가 챗봇을 만들어 드립니다. 서비스 이름과 주소만 적으면 내 챗봇이 생기고, 스크립트 한 줄을 붙이면 그 자리에서 고객 말을 받기 시작합니다. 따로 준비하실 게 없습니다.',
  },
  {
    q: '개발을 몰라도 되나요?',
    a: '스크립트 한 줄을 서비스에 붙일 수 있으면 됩니다. 저장소를 연결하지 않아도 고객 말 받기부터 AI 분류, 반영 알림까지는 그대로 돌아갑니다. 수정안 PR은 저장소를 연결한 분들을 위한 단계입니다.',
  },
  {
    q: 'AI가 우리 코드를 마음대로 고치나요?',
    a: '아니요. 피드루프는 PR을 올리는 데까지만 갑니다. 반영할지는 사람이 보고 정합니다. GitHub에 요구하는 권한도 Contents와 Pull requests 둘뿐입니다.',
  },
  {
    q: '얼마인가요?',
    a: '지금은 베타테스터 기간이라 피드루프 이용료가 없습니다. 내 API 키를 넣으면 한도 없이 쓰고, 드는 돈은 그 키로 나가는 API 요금뿐입니다. 키가 없어도 하루 100건까지는 저희 키로 돌아갑니다.',
  },
  {
    q: 'AI가 엉뚱하게 답하면요?',
    a: '모르는 건 답하지 않고 담당자에게 넘깁니다. 답의 재료가 되는 지식은 대시보드에서 언제든 고칠 수 있고, 고치면 다음 대화부터 바로 반영됩니다.',
  },
  {
    q: '「화면에서 선택하기」로 어디까지 전달되나요?',
    a: '고객이 짚은 요소의 종류와 글자, 다시 찾을 수 있는 선택자와 페이지 안 위치, 태그와 class만 남긴 HTML 뼈대, 화면 좌표, 그 시점의 페이지 주소가 함께 옵니다. 스크린샷과 요소 안 실제 내용, 입력칸에 적힌 값은 보내지 않고, 토큰·이메일·전화번호 같은 값은 저장 전에 지웁니다.',
  },
  {
    q: '이미 채널톡 같은 CS 도구를 쓰는데요?',
    a: '채널톡에 그대로 붙일 수 있습니다. 챗봇을 새로 띄우지 않아도 채널톡으로 들어온 말이 똑같이 분류되고, 반영되면 채널톡으로 알림이 갑니다.',
  },
];

/** 닫힘 +, 열림 ×. 세로획만 돌리면 되므로 path 둘로 끝난다. */
function Toggle() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="mt-[7px] shrink-0 text-[var(--coral-strong)] lg:mt-[9px]"
    >
      <path d="M1 8h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path
        d="M8 1v14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        className="origin-center transition-transform duration-200 group-open:rotate-90"
      />
    </svg>
  );
}

export function FaqSection() {
  return (
    <section
      id="faq"
      className="mx-auto max-w-[1200px] px-6"
      style={{ paddingTop: 'var(--space-section)' }}
    >
      <SectionHead kicker="궁금한 것들" title="FAQ" lead="가장 자주 받은 질문 일곱입니다." />

      {/* ⚠️ 폭을 따로 좁히지 않는다 — 가로선이 섹션 폭(1200px)을 그대로 가로질러야
          위 섹션들의 가로선과 한 줄에서 시작하고 끝난다. 예전엔 여기 `lg:max-w-[820px]` 이
          있어서 FAQ 만 화면 절반에서 끊겼다(ny 지적 9/18). 읽기 폭은 답 문단이 혼자 맡는다. */}
      <div className="mt-8 lg:mt-10">
        {items.map((item, i) => (
          <details
            key={item.q}
            className={`group ${i < items.length - 1 ? 'border-b border-[var(--line)]' : ''}`}
          >
            <summary
              className="flex cursor-pointer list-none items-start gap-4 py-5 font-bold lg:gap-5 lg:py-6 [&::-webkit-details-marker]:hidden"
              style={{
                fontSize: 'var(--fs-h3)',
                lineHeight: 1.5,
                letterSpacing: '-0.02em',
                textWrap: 'pretty',
                wordBreak: 'keep-all',
              }}
            >
              <Toggle />
              <span>{item.q}</span>
            </summary>
            <p
              className="pb-5 pl-[32px] text-[var(--l-muted)] lg:max-w-[820px] lg:pb-6 lg:pl-[36px]"
              style={{
                fontSize: 'var(--fs-body)',
                lineHeight: 1.75,
                textWrap: 'pretty',
                wordBreak: 'keep-all',
              }}
            >
              {item.a}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}
