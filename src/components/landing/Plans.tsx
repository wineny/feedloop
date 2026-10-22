import { useTranslations } from 'next-intl';
import { SectionHead } from './SectionHead';

/**
 * 「붙이는 데 필요한 것」 섹션 (2026-09-18 ny 결정으로 옛 「어디까지 되나요」를 갈아끼웠다).
 *
 * 옛 판은 세 덩어리(플랜 카드 · 채널 추상화 도식 · GitHub 세 갈래 표)가 세로로 쌓여
 * 1440px 에서 오른쪽 절반이 계속 비었고, 429자를 왼쪽에만 흘렸다. 무엇보다
 * **「어떻게 붙이는지」가 랜딩 어디에도 없었다** — 「설치는 5분」만 두 번 나왔다.
 * 그래서 성격을 「붙이고 난 뒤의 한도」에서 「붙이는 데 드는 것」으로 바꿨다.
 *
 * 같이 사라진 것 두 개, 이유를 남긴다.
 *  - `PlansDiagram` (입구 → messages → 루프): 랜딩 한가운데 DB 테이블 이름 `messages` 가
 *    박혀 있었다. 운영자가 읽을 말이 아니다. 「입구가 여럿, 길은 하나」는
 *    `HowItWorks` 의 사실 3줄 「입구」가 대신 말한다.
 *  - 카카오 잠금 문장(ny 지시로 삭제): 도식이 카카오톡을 입구로 그리고 있어서
 *    그 문장이 «지금은 안 된다»를 붙잡고 있었다. 도식을 지웠으니 오해도 같이 사라진다.
 *    카카오를 다시 열 때 랜딩에 넣을 자리는 여기다.
 *
 * ⚠️ 2026-09-18 「하루 N건 무료」 카드를 뺐다(ny 지시). 무료 범위를 랜딩에서 숫자로
 *    약속하지 않는다 — 한도는 `DEFAULT_LIMITS`(lib/llm/limits.ts) 가 쥐고 있고, 화면과
 *    코드가 갈라지면 이 섹션은 그냥 거짓말이 된다. 다시 넣을 자리는 여기다.
 *
 * ⚠️ 읽는 사람은 «쓰려는 사람»이지 우리가 아니다. 「우리 키」·「우리 계정」처럼
 *    파는 쪽을 주어로 놓지 않는다 (ny 지시 9/18). 모델 이름·버전도 적지 않는다.
 */

/**
 * 붙이는 스니펫. 실물은 `WebWidgetConnectGuide` 가 봇마다 만들어 준다
 * (`<script src="{baseUrl}/widget.js" data-feedloop="{botId}" async></script>`).
 * 랜딩에선 주소와 봇 ID 를 아직 모르니 그 자리만 줄인다 — 없는 도메인을 지어내지 않는다.
 */

/**
 * 도입 세 단계. 실제 온보딩 순서 그대로다 — 봇 등록(`/bots/new`) → 스니펫 심기
 * (`/bots/[id]/connect`) → GitHub 연결.
 *
 * 이모지는 이미 쓰고 있는 Microsoft Fluent Emoji 3D 세트다(MIT). `robot_3d` 와 `link_3d`
 * 둘만 새로 받았다 — 나머지 일곱은 4단계 타임라인 등이 쓰고 있다.
 * ⚠️ 코드 여기저기의 「애플 3D 이모지」라는 옛 표현은 오기다. 받아 보면 Fluent 쪽이다.
 */
const steps = [
  { key: 'bot', emoji: '/emoji/robot_3d.png' },
  { key: 'script', emoji: '/emoji/electric_plug_3d.png', snippet: true },
  { key: 'github', emoji: '/emoji/link_3d.png' },
] as const;

export function PlansSection() {
  const t = useTranslations('landing');
  return (
    <section id="scale" className="mx-auto max-w-[1200px] px-6" style={{ paddingTop: 'var(--space-section)' }}>
      <SectionHead kicker={t('plans.kicker')} title={t('plans.title')} lead={t('plans.lead')} />

      <div className="mt-10 grid gap-4 lg:mt-12 lg:grid-cols-3 lg:gap-6">
        {steps.map((step, i) => (
          <div key={step.key} className="flex flex-col rounded-[16px] border border-[var(--line)] p-6 lg:p-7">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={step.emoji} alt="" loading="lazy" className="h-12 w-12 lg:h-14 lg:w-14" />
            <div className="mt-4 text-sm font-semibold text-[var(--coral)]">{String(i + 1).padStart(2, '0')}</div>
            <div
              className="mt-1.5 text-[22px] font-extrabold leading-[1.25] tracking-[-0.02em] lg:text-[26px]"
              style={{ textWrap: 'pretty', wordBreak: 'keep-all' }}
            >
              {t(`plans.steps.${step.key}.title`)}
            </div>
            {step.key === 'script' && (
              <code
                className="mt-4 block overflow-x-auto rounded-[10px] bg-[var(--chip)] px-3.5 py-3 text-[var(--l-muted)]"
                style={{ fontSize: 12, lineHeight: 1.6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
              >
                {`<script src="…/widget.js" data-feedloop="${t('plans.botId')}" async></script>`}
              </code>
            )}
            <p
              className="mt-3.5 text-[var(--l-muted)]"
              style={{ fontSize: 'var(--fs-body)', lineHeight: 1.7, textWrap: 'pretty', wordBreak: 'keep-all' }}
            >
              {t(`plans.steps.${step.key}.desc`)}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
