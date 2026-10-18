#!/usr/bin/env bash
# 감사 매트릭스 16실행: realtime/batch × gemini-2.5-flash/-lite × 골든/홀드아웃 × 2회.
# 워크트리 루트에서 `bash scripts/audit-matrix.sh`. 결과는 evals/classify/audit-2026-09-12/runs/.
# 요약 `npx tsx scripts/summarize-audit.ts` · 라벨 효과 분리 `npx tsx scripts/rescore-audit.ts`.
# ⚠️ Gemini 실호출(비용). 순차 실행이라 12~15분.
set -u
OUT=evals/classify/audit-2026-09-12/runs
for model in gemini-2.5-flash gemini-2.5-flash-lite; do
  for path in realtime batch; do
    for set in golden-set holdout-set; do
      for run in 1 2; do
        name="${path}-${model}-${set}-r${run}"
        echo "[$(date +%H:%M:%S)] START $name"
        npx tsx scripts/eval-classify.ts --path "$path" --model "$model" \
          --set "evals/classify/${set}.json" \
          --save "$OUT/${name}.json" > "$OUT/${name}.log" 2>&1
        rc=$?   # echo 뒤에서 $? 를 읽으면 echo 의 0 이 잡힌다
        echo "[$(date +%H:%M:%S)] EXIT=$rc $name"
      done
    done
  done
done
echo "ALL_DONE"
