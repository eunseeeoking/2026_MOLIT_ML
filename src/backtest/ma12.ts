/**
 * MA-12 (12개월 이동평균) 베이스라인 예측.
 *
 * 모델 정의:
 *   · 학습 구간 마지막 12개월 평균 = "현재 수준"
 *   · 학습 구간 전체에 대한 선형회귀 기울기(만원/㎡ per month) = "트렌드"
 *   · h개월 후 예측 = level + slope × h
 *
 * 즉 단순 이동평균 + 선형 트렌드 외삽.
 *
 * 7day-roadmap.md §DAY5 "단순 이동평균(MA-12) 베이스라인 — 행정동 단위 12개월 평균"
 * → 본 구현은 단지 단위지만 로직은 동일.
 *
 * 출력: train.length 의 길이를 갖는 fit 시계열 (학습 구간 재현) + 예측 horizon 길이.
 */

import type { MonthlyPoint } from '../data/preprocess';

export interface Ma12Forecast {
  /** 학습 구간 in-sample fit (이동평균 사용) */
  trainFit: number[];
  /** 학습 종료 이후 horizon 개월 예측 */
  prediction: number[];
  level: number;
  slopePerMonth: number;
}

export function predictMa12(
  train: MonthlyPoint[],
  horizon: number,
): Ma12Forecast {
  if (train.length < 12) {
    throw new Error(`MA-12 needs ≥12 months train, got ${train.length}`);
  }

  const prices = train.map((p) => p.pricePerM2);

  // 1) Level — 마지막 12개월 평균
  const last12 = prices.slice(-12);
  const level = last12.reduce((a, b) => a + b, 0) / last12.length;

  // 2) Slope — 학습 구간 전체에 대한 단순 선형회귀 (x = month index)
  const n = prices.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += prices[i];
    sumXY += i * prices[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;

  // 3) in-sample fit — 12개월 이동평균 (앞 12개월은 cumulative mean 으로 대체)
  const trainFit: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i < 12) {
      const win = prices.slice(0, i + 1);
      trainFit.push(win.reduce((a, b) => a + b, 0) / win.length);
    } else {
      const win = prices.slice(i - 11, i + 1); // 직전 12개월
      trainFit.push(win.reduce((a, b) => a + b, 0) / 12);
    }
  }

  // 4) 예측 — level + slope × h (h: 1..horizon)
  const prediction: number[] = [];
  for (let h = 1; h <= horizon; h++) {
    prediction.push(level + slope * h);
  }

  return { trainFit, prediction, level, slopePerMonth: slope };
}
