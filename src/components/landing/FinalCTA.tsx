import { useTranslations } from 'next-intl';
import { PrimaryCta } from './PrimaryCta';
import { SectionHead } from './SectionHead';

/**
 * 마지막 CTA — 페이지의 마침표. 푸터 바로 위, 랜딩의 «맨 아래»다.
 *
 * 2026-09-18 ny 지시로 두 가지가 같이 바뀌었다 —
 *   ① FAQ 아래로 내려 랜딩의 마지막 블록이 됐다.
 *   ② 흰 지면 위 중앙 정렬 한 덩이였던 게 **코랄 띠**가 됐다.
 * ②가 ①의 조건이다. 흰 지면에서는 이 섹션만 중앙 정렬이라 「얘만 왜 가운데지」로 읽혔다.
 * 띠가 깔리면 중앙 정렬이 «닫는 면»의 문법이 되어 어색함이 사라진다.
 *
 * 띠는 **연한 코랄 그라데이션**이다. 평평한 `--coral-tint-2` 한 색은 밍밍했고, 짙은 코랄은
 * 너무 셌다(ny 2026-09-18, 두 번의 되돌림). 지금은 연한 지면에 결만 넣는 쪽이다.
 *
 * ⚠️ 연한 지면이므로 글·버튼은 **흰 지면과 같은 색**을 쓴다. 짙게 갈 일이 생기면 글자만
 *    흰색으로 덮어선 안 된다 — 배지는 `--coral-strong`, 리드는 `--l-muted` 라 코랄 위 코랄,
 *    회색 위 회색이 된다. 머리 세 층이 한 벌로 뒤집혀야 한다.
 *
 * ⚠️ 위아래 안쪽 여백은 `--space-section` 의 **절반**이다(ny 지시 — 띠가 화면을 너무 먹었다).
 *    다른 섹션과 달리 이 띠만 반 칸인 건 의도다. 색 면이 이미 «여기가 끝»을 말하므로
 *    여백까지 한 칸을 쓸 이유가 없다.
 *
 * ⚠️ 여백 배치는 데모 띠와 «같은 문법»이다 — 위 여백은 띠 **밖**(marginTop: 앞 섹션과
 *    떨어뜨린다), 안쪽 여백은 띠 **안**(padding: 색 면이 글을 품는다). 아래쪽은 푸터의
 *    `border-t` 가 띠 끝에 바로 닿으므로 따로 띄우지 않는다.
 *
 * ⚠️ 앞에 오는 `FaqSection` 은 **아래 여백이 없다** — 여기 `marginTop` 이 그 몫이다.
 *    순서를 바꾸면 둘 중 하나가 여백을 잃거나 두 번 쌓인다. 같이 본다.
 *
 * 라이브 데모 박스는 여기서 「작동 방식」 끝으로 올렸다 — 그건 마침표가 아니라 증거다.
 */
/**
 * 닫는 면. 오른쪽 위에서 살구빛이 들고 왼쪽 아래가 코랄로 살짝 가라앉는다.
 * 두 radial 은 «빛과 그늘»이고 아래 linear 가 바탕이다 — 순서를 바꾸면 그늘이 빛을 덮는다.
 *
 * ⚠️ 바탕은 토큰(`--coral-tint`·`--coral-tint-2`)으로 깐다. 다크 모드에서 두 토큰이 어두운
 *    값으로 뒤집히므로 띠도 같이 뒤집힌다 — 밝은 색을 박아 넣으면 다크에서 흰 글자가
 *    밝은 지면에 얹혀 안 보인다. 위 두 겹은 반투명이라 어느 바탕에서든 결로만 얹힌다.
 */
const CLOSING_FIELD =
  'radial-gradient(70% 120% at 86% 0%, rgba(255,206,184,.55), transparent 60%),' +
  'radial-gradient(76% 130% at 8% 100%, rgba(242,100,92,.20), transparent 66%),' +
  'linear-gradient(135deg, var(--coral-tint) 0%, var(--coral-tint-2) 55%, var(--coral-tint) 100%)';

export function FinalCTA() {
  const t = useTranslations('landing');
  return (
    <section
      id="start"
      className="text-center"
      style={{
        background: CLOSING_FIELD,
        marginTop: 'var(--space-section)',
        paddingTop: 'calc(var(--space-section) / 2)',
        paddingBottom: 'calc(var(--space-section) / 2)',
      }}
    >
      <div className="mx-auto max-w-[1200px] px-6">
        <SectionHead
          align="center"
          kicker={t('final.kicker')}
          title={t('final.title')}
          lead={t('final.lead')}
        />
        <PrimaryCta
          className="mt-8 inline-flex w-full items-center justify-center gap-2 rounded-full bg-[var(--ink)] font-bold text-white sm:w-auto lg:mt-9 lg:px-5"
          style={{ height: 'var(--btn-h)', fontSize: 'var(--fs-body)' }}
        />
      </div>
    </section>
  );
}
