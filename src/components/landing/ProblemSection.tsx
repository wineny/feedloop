/**
 * 「문제 공감」 섹션 + Why now — 목업 B안(에디토리얼, 2026-09-18 ny 확정).
 *
 * ⚠️ 말 거는 상대는 «운영자»다 — 피드백을 «보내는» 고객이 아니다 (ny 지시 2026-09-18).
 *    돈을 내고 이걸 붙일 사람은 서비스를 만들고 굴리는 쪽이라, 그 사람의 하루에서 아픈 데를 짚는다.
 *
 * ⚠️ 제목은 «주어가 있는 문장»이어야 한다 (ny 지시 2026-09-18). 예전 제목
 *    「안 고치는 게 아니라, 못 고치는 겁니다」는 히어로 다음에 주어 없이 튀어나와
 *    «갑자기 이 얘기가 왜 나오지»가 됐다. 그 카피는 리드 첫 문장으로 살아 있다.
 *
 * 왼쪽은 배지·제목·리드(+배경 한 줄), 오른쪽은 단문 세 줄이다.
 *
 * ⚠️ 오른쪽 열은 배경 없이 「01 이건 나중에 보자」로 바로 시작했었다 — 누가 하는 말인지,
 *    무엇에 대한 말인지가 없어 허공에 떴다(ny 지적 2026-09-18). 배경 줄(`SETUP`)이 그 답이고,
 *    지금은 왼쪽 리드 아래에 있다.
 *
 * ⚠️ 같은 날 속말 네 줄(「이건 나중에 보자」류)을 단문 세 줄로 갈았다. 속말은 두루뭉술해서
 *    어느 서비스 얘기든 될 수 있었다 — 넷 중 마지막 하나만 와닿았다. 지금 세 줄은 아픈 데의
 *    «기제»를 지목한다: CS 에 묻힘 · 분류가 없음 · 알려주는 사람이 없음.
 *
 * ⚠️ 2026-09-18 「왜 지금인가」 블록을 지웠다(ny 결정). 랜딩에서 유일하게 운영자의 아픈 데가
 *    아니라 «시장 흐름»을 말하는 문단이었다. 심사용 서사는 제출 폼 텍스트 4칸이 맡는다.
 *
 * ⚠️ 세로 코랄선(border-l)은 **의도적으로 뺐다** — 좌측 테두리 카드는 AI 티 패턴이다(ny 지시).
 *    행을 가르는 건 가로선 하나뿐이고, 왼쪽 열은 번호가 지킨다.
 *
 * ⚠️ 머리(배지·제목·리드)는 `SectionHead` 가 맡는다. 예전엔 이 섹션만 h2 를 48px 로
 *    따로 조판했는데, 그게 섹션 리듬이 어긋나 보인 원인이었다(ny 지적 9/18).
 *
 * 세 줄은 아래 섹션이 답하는 순서와 맞물린다 —
 *   ① CS 에 묻힘        → 「피드백」   AI 가 1차 응대해 CS 를 덜어준다
 *   ② 분류가 없음        → 「AI 분류」  나누고 묶는다
 *   ③ 알려주는 사람이 없음   → 「수정 PR · 반영 알림」  ③ 의 「개선을 해도」가 수정 부담까지 받는다
 * 줄을 고치면 이 대응이 깨지는지 먼저 본다.
 */
import { SectionHead } from './SectionHead';

/**
 * 배경 한 줄. 이게 없으면 아래 셋이 «누구 얘기»인지 서지 않는다.
 * 2026-09-18 목록 맨 위에서 «왼쪽 리드 아래»로 옮겼다(ny 지시) — 진단(왼쪽)이
 * 한자리에 모이고, 오른쪽은 증상 셋만 남아 목록이 깔끔해진다.
 */
const SETUP = '고객은 이미 말해주고 있습니다. 문제는 그 다음입니다.';

interface Pain {
  /** 한 줄로 뜻이 서는 단문. 이 줄이 주인공이라 28px 로 조판한다. */
  line: string;
  /** 어떻게 그러는지를 받는 한두 문장. */
  desc: string;
  /** 마지막 한 줄만 «손실»이다. 앞 둘은 번거로움이라 회색, 이 줄만 본문색으로 무게를 준다. */
  cost?: boolean;
}

const pains: Pain[] = [
  {
    line: '개선 피드백은 CS에 묻힙니다',
    desc: '급한 문의부터 쳐내면 하루가 끝납니다.',
  },
  {
    line: '비슷한 피드백이 쌓이기만 하고, 분류가 안 됩니다',
    desc: '뒤죽박죽 섞인 채 불어나서, 나중엔 어디부터 손댈지도 모릅니다.',
  },
  {
    line: '개선을 해도, 제보해준 고객은 모릅니다',
    desc: '아무도 개선 사실을 알려주지 않습니다.',
    cost: true,
  },
];

export function ProblemSection() {
  return (
    <section
      className="mx-auto max-w-[1200px] px-6 lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start lg:gap-x-20"
      style={{ paddingTop: 'var(--space-section)' }}
    >
      <SectionHead
        kicker="지금 벌어지는 일"
        title={
          <>
            피드백은 쌓이는데,
            <br />
            개선은 안 됩니다
          </>
        }
        lead={
          <>
            안 고치는 게 아니라, 못 고치는 겁니다.
            <br />
            {SETUP}
          </>
        }
      />

      <div className="mt-9 lg:mt-0">
        {pains.map((t, i) => (
          <div
            key={t.line}
            className={`grid grid-cols-[38px_minmax(0,1fr)] gap-x-4 lg:grid-cols-[56px_minmax(0,1fr)] lg:gap-x-6 ${
              i === 0 ? 'pb-5 lg:pb-6' : 'py-5 lg:py-6'
            } ${i < pains.length - 1 ? 'border-b border-[var(--line)]' : ''}`}
          >
            <span
              className="pt-[7px] font-bold text-[var(--coral-strong)] lg:pt-[10px]"
              style={{ fontSize: 13, letterSpacing: '0.02em', fontVariantNumeric: 'tabular-nums' }}
            >
              {String(i + 1).padStart(2, '0')}
            </span>
            <div>
              <p
                className="font-bold"
                style={{
                  fontSize: 'clamp(20px, 5.2vw, 28px)',
                  lineHeight: 1.35,
                  letterSpacing: '-0.03em',
                  textWrap: 'balance',
                }}
              >
                {t.line}
              </p>
              <p
                className={`mt-2 max-w-[54ch] lg:mt-2.5 ${
                  t.cost ? 'font-medium text-[var(--ink)]' : 'text-[var(--l-muted)]'
                }`}
                style={{ fontSize: 'var(--fs-body)', lineHeight: 1.7, textWrap: 'pretty' }}
              >
                {t.desc}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
