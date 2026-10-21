import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

interface LoopStagesProps {
  stats: {
    collected: number;
    classified: number;
    prCreated: number;
    returned: number;
  };
  /** 칸 아래 보조 문구. 값이 없으면 비운다 — 없는 숫자를 지어내지 않는다 */
  notes?: Partial<Record<'collected' | 'classified' | 'prCreated' | 'returned', string>>;
}

/**
 * 루프 단계 — 이 화면이 «크게 말하는 한 가지».
 *
 * 앞선 판(`StatsCards`)은 이걸 같은 크기 네 칸에 점 표시(●○○○)로 그렸다. 그러면 퍼널이
 * 「지표 네 개」로 읽히고, 제품의 유일한 주장이 숨는다.
 *
 * 이건 퍼널이 아니라 **루프**다. 마지막 칸(되돌림)이 첫 칸(들어온 피드백)에게 돌아간다 —
 * 그게 「피드백 보낸 유저가 무시당하지 않는다」는 명제 전부고, 로고가 이미 무한 루프 마크다.
 * 그래서 네 칸을 «하나로 이어진» 화살표가 꿰고 지나가며 앞으로 가는 흐름을 보인다.
 * 되돌아오는 한 걸음은 아래 한 줄로 적는다. 예전엔 그 한 걸음을 네 칸 아래 U 자 선으로
 * 그렸는데, PC 폭에서 가로가 800px 넘게 늘어나는데 깊이는 40px 고정이라 루프가 아니라
 * 괄호로 읽혔다(ny 지적 2026-09-18).
 *
 * 점 표시는 뺐다 — 칸마다 점 개수가 달라 「4단계 중 n번째」로 읽히는데, 진행을 실제로 말해주는
 * 건 숫자가 줄어드는 것이다. 점은 같은 말을 약하게 되풀이했다.
 *
 * 이모지는 `public/emoji/` 에 **이미 self-host 돼 있는** Fluent 3D 를 쓴다. 외부 CDN 을 안 쓰는
 * 이유는 심사 기간(9/21~10/5) 외부 의존을 늘리지 않기 위해서다 — Pretendard 를 npm 으로
 * self-host 한 것과 같은 판단이다.
 */
const stages = [
  { key: 'collected', emoji: '/emoji/mailbox_3d.png' },
  { key: 'classified', emoji: '/emoji/card_index_dividers_3d.png' },
  { key: 'prCreated', emoji: '/emoji/hammer_and_wrench_3d.png' },
  { key: 'returned', emoji: '/emoji/love_letter_3d.png' },
] as const;

/**
 * 네 단계를 꿰는 화살표. 토막이 아니라 «하나»다(ny 시안 2026-09-18).
 *
 * 라벨 줄 «뒤»에 깔린다 — 격자 칸으로 만들지 않고 절대 배치로 통째로 지나가게 하고,
 * 겹치는 자리는 라벨 쪽이 바탕색으로 가린다(`Stage` 의 라벨 줄). 그래야 글자 양옆이
 * 자연스럽게 뚫린 것처럼 보인다. 격자 칸으로 만들면 칸 개수만큼 토막이 난다 —
 * 앞선 판이 그랬고, 그러면 한 흐름이 아니라 칸마다 붙은 장식으로 읽힌다.
 *
 * `top-[2px]` 는 이모지 줄(24px)에 화살표(20px)의 가운데를 맞추는 값이다 —
 * 숫자가 아니라 라벨 높이에 걸어야 네 칸을 한 줄로 관통한다.
 *
 * 모바일(2×2)에서는 안 그린다. 줄이 둘이라 한 줄로 꿸 수가 없다.
 */
function FlowArrow() {
  return (
    <span
      aria-hidden
      className="stage-flow pointer-events-none absolute inset-x-0 top-[2px] z-0 hidden h-5 sm:block"
    />
  );
}

function Stage({
  emoji,
  label,
  value,
  note,
  isLast,
}: {
  emoji: string;
  label: string;
  value: number;
  note?: string;
  isLast: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {/* 이모지는 라벨과 «같은 줄»에 둔다. 따로 한 줄을 주면 칸 하나가 세로로 40px 가까이 길어지고,
          네 칸이 나란히 서므로 화면 위쪽이 통째로 밀린다(ny 지적 2026-09-18). */}
      {/* `bg-canvas` + 좌우 패딩은 뒤로 지나가는 화살표를 «가리는» 장치다. 음수 마진으로
          같은 만큼 되물려 글자 위치는 그대로 두고 배경만 양옆으로 넓힌다 — 그래야 화살표가
          글자에 닿기 전에 끊겨 「뒤로 지나간다」로 읽힌다. z-10 이 화살표(z-0) 위로 올린다.
          ⚠️ 바탕색이 `--canvas` 가 아닌 곳에 이 컴포넌트를 두면 이 띠가 드러난다 */}
      <div className="relative z-10 -mx-2.5 flex w-fit min-w-0 items-center gap-1.5 self-start bg-canvas px-2.5">
        <Image src={emoji} alt="" width={24} height={24} className="h-6 w-6 shrink-0" aria-hidden />
        <p className="min-w-0 text-sm font-semibold leading-snug">{label}</p>
      </div>
      {/* 보조 문구는 숫자 «오른쪽»에 베이스라인을 맞춰 붙인다(ny 지적 2026-09-18).
          아래로 내리면 칸마다 줄 수가 달라져 네 칸의 끝이 들쭉날쭉해지고, 그 밑을 지나는
          되돌림 곡선이 기울어 보였다. 옆에 두면 칸 높이가 문구 유무와 무관하게 같아진다.
          좁은 칸에서 문구가 안 들어가면 `flex-wrap` 이 받아 아랫줄로 흘린다. */}
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <p
          className={cn(
            'text-[28px] font-extrabold leading-none tracking-[-0.03em] tabular-nums',
            isLast && 'text-brand-strong',
          )}
        >
          {value}
        </p>
        {note && <p className="min-w-0 text-[12.5px] leading-[1.45] text-faint">{note}</p>}
      </div>
    </div>
  );
}

export function LoopStages({ stats, notes }: LoopStagesProps) {
  const t = useTranslations('dashboard.stages');
  const returned = stats.returned;

  return (
    <section aria-label={t('label')}>
      {/* 화살표가 네 칸을 통째로 지나가야 하므로 격자 «바깥»을 기준 상자로 삼는다 */}
      <div className="relative">
        <FlowArrow />
        <div className="grid grid-cols-2 items-start gap-x-6 gap-y-8 sm:grid-cols-4 sm:gap-x-4">
          {stages.map((s) => (
            <Stage
              key={s.key}
              emoji={s.emoji}
              label={t(s.key)}
              value={stats[s.key]}
              note={notes?.[s.key]}
              isLast={s.key === 'returned'}
            />
          ))}
        </div>
      </div>

      {/* 되돌아오는 한 걸음. 화살표는 앞으로 가는 흐름만 말하므로 이 줄이 루프를 닫는다.
          되돌림이 0건이면 사실 대신 «앞으로 이렇게 된다»를 적는다 — 없는 숫자를 지어내지 않는다 */}
      <p className="mt-7 flex items-center gap-1.5 text-[12.5px] font-semibold text-brand-strong">
        <span aria-hidden>↻</span>
        {returned > 0
          ? t('returnedCount', { count: returned })
          : t('returnedHint')}
      </p>
    </section>
  );
}
