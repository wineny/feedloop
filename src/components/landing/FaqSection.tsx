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
import { useTranslations } from 'next-intl';
import { SectionHead } from './SectionHead';

const ITEM_KEYS = ['noBot', 'noDev', 'codeSafety', 'price', 'wrongAnswer', 'pick', 'channelTalk'] as const;

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
  const t = useTranslations('landing');
  return (
    <section
      id="faq"
      className="mx-auto max-w-[1200px] px-6"
      style={{ paddingTop: 'var(--space-section)' }}
    >
      <SectionHead kicker={t('faq.kicker')} title={t('faq.title')} lead={t('faq.lead')} />

      {/* ⚠️ 폭을 따로 좁히지 않는다 — 가로선이 섹션 폭(1200px)을 그대로 가로질러야
          위 섹션들의 가로선과 한 줄에서 시작하고 끝난다. 예전엔 여기 `lg:max-w-[820px]` 이
          있어서 FAQ 만 화면 절반에서 끊겼다(ny 지적 9/18). 읽기 폭은 답 문단이 혼자 맡는다. */}
      <div className="mt-8 lg:mt-10">
        {ITEM_KEYS.map((key, i) => (
          <details
            key={key}
            className={`group ${i < ITEM_KEYS.length - 1 ? 'border-b border-[var(--line)]' : ''}`}
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
              <span>{t(`faq.items.${key}.q`)}</span>
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
              {t(`faq.items.${key}.a`)}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}
