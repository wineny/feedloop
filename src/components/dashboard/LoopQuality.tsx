import { cn } from '@/lib/utils';
import { formatLoopDuration, type LoopTimeStats } from '@/lib/dashboard/loop-time';
import { confirmationRates, formatRate, type ConfirmationStats } from '@/lib/dashboard/confirmation';

// 루프의 «질» 칸 — 단계별 건수(StatsCards)가 답하지 못하는 두 가지를 말한다.
// ① 얼마나 걸렸나 ② 정말 고쳐졌다고 하던가.
// 상자·그림자 없이 헤어라인으로 가른 셀 + 26/800 tabular 숫자 — StatsCards 와 같은 체계다.
//
// 「아직 없음」(표본이 없다)과 「집계 못 함」(못 읽었다)을 다르게 적는다. 같은 말로 그리면
// 깨진 집계가 조용한 사실처럼 보인다.

interface LoopQualityProps {
  loopTime?: LoopTimeStats;
  confirmation?: ConfirmationStats;
}

interface MetricCellProps {
  label: string;
  /** 값이 없으면 undefined — 칸은 `emptyLabel` 을 말한다 */
  value?: string;
  emptyLabel: string;
  note: string;
  /** StatsCards 와 같은 2열 규칙: 둘째 칸부터 왼선 */
  index: number;
}

function MetricCell({ label, value, emptyLabel, note, index }: MetricCellProps) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5 p-5 sm:p-6', index % 2 === 1 && 'border-t border-border sm:border-l sm:border-t-0')}>
      <span className="text-[12.5px] font-medium text-muted-foreground">{label}</span>
      {/* 24/800 — 루프 단계의 40px 보다 한 단계 «작다». 이 둘은 주인공이 아니라 각주다.
          큰 숫자가 한 화면에 여섯 번 나오던 것이 위계를 지우던 원인이었다. */}
      <p
        className={cn(
          'text-2xl font-extrabold leading-tight tracking-[-0.025em] tabular-nums',
          !value && 'text-lg text-muted-foreground',
        )}
      >
        {value ?? emptyLabel}
      </p>
      <span className="min-h-[18px] text-[12.5px] leading-[1.45] text-faint">{note}</span>
    </div>
  );
}

/**
 * 왼쪽 = 얼마나 걸렸나(정의는 `lib/dashboard/loop-time.ts`),
 * 오른쪽 = 정말 고쳐졌다고 하던가(정의는 `lib/dashboard/confirmation.ts`).
 */
export function LoopQuality({ loopTime, confirmation }: LoopQualityProps) {
  const timeFailed = loopTime?.state === 'error';
  const sampleSize = loopTime?.sampleSize ?? 0;
  const averageMs = loopTime?.averageMs ?? null;

  const confirmFailed = confirmation?.state === 'error';
  const { answered, fixedRate, responseRate } = confirmationRates(confirmation);
  const delivered = confirmation?.delivered ?? 0;

  // v4: 루프 단계가 화면 위로 빠져 나가면서 이 둘은 독립한 카드가 됐다.
  // 모바일은 세로로 쌓는다 — 2열로 두면 「제보 → 반영 알림 평균」 같은 라벨이 두 줄로 접힌다.
  return (
    <div className="card-surface grid grid-cols-1 sm:grid-cols-2">
      <MetricCell
        index={0}
        label="제보 → 반영 알림 평균"
        value={!timeFailed && sampleSize > 0 && averageMs !== null ? formatLoopDuration(averageMs) : undefined}
        emptyLabel={timeFailed ? '집계 못 함' : '아직 없음'}
        note={
          timeFailed
            ? '표본을 다 읽지 못했어요 · 새로고침해 주세요'
            : sampleSize > 0
              ? `반영 알림 ${sampleSize}건 기준`
              : '반영 알림이 나가면 그때부터 잽니다'
        }
      />
      <MetricCell
        index={1}
        label="「네, 잘 돼요」 비율"
        value={!confirmFailed && fixedRate !== null ? formatRate(fixedRate) : undefined}
        emptyLabel={confirmFailed ? '집계 못 함' : '아직 없음'}
        note={
          confirmFailed
            ? '답을 다 읽지 못했어요 · 새로고침해 주세요'
            : answered > 0
              ? `웹 위젯 기준 · 답한 ${answered}건 중 ${confirmation?.fixed ?? 0}건${responseRate !== null ? ` · 응답률 ${formatRate(responseRate)}` : ''}`
              : delivered > 0
                ? `웹 위젯 기준 · 반영 알림 ${delivered}건 중 아직 답이 없어요`
                : '웹 위젯 카드에서 답을 받으면 채워져요'
        }
      />
    </div>
  );
}
