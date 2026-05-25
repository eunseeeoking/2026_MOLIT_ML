/**
 * 시계열 hold-out 분리.
 *
 * Day 5 백테스트 시나리오:
 *   · 전체 시계열을 [학습용 train] + [평가용 test 36개월] 로 분리
 *   · train 으로 모델 학습 → test 기간의 36개월을 예측 → 실제와 비교
 *
 * horizon=36 이지만 단지별 시계열 길이가 짧으면 가용 horizon 으로 자동 축소.
 */

import type { MonthlyPoint } from '../data/preprocess';

export interface HoldoutSplit {
  train: MonthlyPoint[];     // 학습 구간 (앞쪽)
  test: MonthlyPoint[];      // 평가 구간 (뒤 horizonMonths 개월)
  horizon: number;           // 실제 사용된 horizon (요청 horizon 보다 작을 수 있음)
}

/**
 * series 를 [train | test] 로 분리.
 * @param series          forward-fill 완료된 월별 시계열
 * @param horizonMonths   tail 평가 길이 (기본 36)
 * @param minTrainMonths  최소 학습 길이 (기본 48 = 4년)
 *                        → 학습+평가가 minTrainMonths+horizon 이상이어야 정상 분리
 */
export function splitHoldout(
  series: MonthlyPoint[],
  horizonMonths = 36,
  minTrainMonths = 48,
): HoldoutSplit {
  if (series.length < minTrainMonths + 12) {
    throw new Error(
      `series too short: ${series.length} < ${minTrainMonths + 12} (minTrain+12)`,
    );
  }

  // 가용 horizon = min(horizonMonths, series.length - minTrainMonths)
  const horizon = Math.min(
    horizonMonths,
    Math.max(12, series.length - minTrainMonths),
  );

  const trainEnd = series.length - horizon;
  return {
    train: series.slice(0, trainEnd),
    test: series.slice(trainEnd),
    horizon,
  };
}
