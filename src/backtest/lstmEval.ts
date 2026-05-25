/**
 * LSTM hold-out 평가.
 *
 * 전략 — Recursive Multi-Step:
 *   1) train 구간으로 horizon=1 LSTM 학습 (기존 trainLstm 재사용)
 *      입력 window=24개월 z-score → 다음 1개월 z-score 예측
 *   2) train 마지막 24개월을 시드 윈도우로 predictNext() 반복 호출
 *      예측값을 윈도우에 push → 가장 오래된 값 shift → 다음 step
 *      총 horizon 회 반복하여 1..horizon 개월 예측 시계열 생성
 *   3) z-score 복원 → 만원/㎡ 단위
 *
 * 누적 오차로 horizon 끝쪽이 외삽 폭주 가능 → MAPE/RMSE 평가에서 적나라하게 드러남.
 * 이게 백테스트의 본질: "장기 예측에서 LSTM 이 정말 단순 MA 보다 나은가?"
 *
 * R-ONE 정규화 옵션 (2026-05-24 추가):
 *   reb 옵션 전달 시 → 학습 전 시계열을 R-ONE 지수로 정규화 → 예측 후 역정규화
 *   효과: 시장 거시 추세 노이즈 제거 → 동/단지 고유 변동에만 집중
 *   백테스트 정책: train 마지막 ym 의 index 만 사용 (운영 시뮬레이션, 보수적)
 */

import { buildTrainExamples, type MonthlyPoint } from '../data/preprocess';
import { trainLstm, predictNext } from '../models/lstm';
import {
  preloadIndex,
  normalizeSeries,
  denormalizePredictions,
  getNearestIndex,
} from '../data/rebNormalize';

export interface LstmForecast {
  /** train 마지막 시점부터 1..horizon 개월 후 예측 (만원/㎡) */
  prediction: number[];
  /** 학습 검증 지표 */
  trainMape: number;
  trainMae: number;
  /** scale (z-score) 정보 */
  scale: { mean: number; std: number };
  /** R-ONE 정규화 적용 여부 + coverage (0~1) */
  rebApplied?: boolean;
  rebCoverage?: number;
  rebIndexFactor?: number;
}

const DEFAULT_WINDOW = 24;
const DEFAULT_EPOCHS = 30;

export interface LstmEvalOpts {
  window?: number;
  epochs?: number;
  /** R-ONE 정규화 활성화 시 시군구코드 필요 */
  reb?: { sigunguCode: string };
}

export async function predictLstm(
  train: MonthlyPoint[],
  horizon: number,
  opts?: LstmEvalOpts,
): Promise<LstmForecast> {
  const window = opts?.window ?? DEFAULT_WINDOW;
  const epochs = opts?.epochs ?? DEFAULT_EPOCHS;

  if (train.length < window + 4) {
    throw new Error(
      `LSTM needs ≥${window + 4} months train, got ${train.length}`,
    );
  }

  /* ─── R-ONE 정규화 (선택) ─── */
  let workingTrain = train;
  let rebApplied = false;
  let rebCoverage = 0;
  let rebIndexFactor = 0;

  if (opts?.reb) {
    const indexMap = await preloadIndex(opts.reb.sigunguCode);
    if (indexMap.size > 0) {
      const { normalized, coverage } = normalizeSeries(train, indexMap);
      if (coverage > 0.5) {
        workingTrain = normalized;
        rebApplied = true;
        rebCoverage = coverage;
        // 백테스트 복원 정책: train 마지막 ym 의 index 사용
        const lastYm = train[train.length - 1].ym;
        rebIndexFactor = getNearestIndex(indexMap, lastYm) ?? 0;
      } else {
        console.warn(
          `[lstmEval] R-ONE coverage 낮음 (${(coverage * 100).toFixed(0)}%) — 정규화 미적용`,
        );
      }
    }
  }

  // 1) horizon=1 학습 examples 빌드
  const { examples, scale } = buildTrainExamples(workingTrain, window, 1);
  if (examples.length < 8) {
    throw new Error(
      `not enough LSTM examples: ${examples.length} (need ≥8)`,
    );
  }

  // 2) 학습 (기존 trainLstm 그대로)
  const { model, mae, mape } = await trainLstm(examples, {
    windowSize: window,
    epochs,
  });

  // 3) 시드 윈도우 = workingTrain 마지막 window 개월 z-score
  const prices = workingTrain.map((p) => p.pricePerM2);
  const seedZ = prices.slice(-window).map((v) => (v - scale.mean) / scale.std);

  // 4) Recursive multi-step
  const predictionZ: number[] = [];
  const cursor = [...seedZ];
  for (let h = 0; h < horizon; h++) {
    const nextZ = await predictNext(model, cursor);
    predictionZ.push(nextZ);
    cursor.push(nextZ);
    cursor.shift();
  }

  // 5) z-score 복원 → 정규화된 단위 (R-ONE 적용 시 "기준 100 정규화값")
  let prediction = predictionZ.map((z) => z * scale.std + scale.mean);

  // 6) R-ONE 역정규화 (예측값 × indexFactor / 100)
  if (rebApplied) {
    prediction = denormalizePredictions(prediction, rebIndexFactor);
  }

  model.dispose();

  return {
    prediction,
    trainMape: mape,
    trainMae: mae,
    scale,
    rebApplied,
    rebCoverage,
    rebIndexFactor: rebApplied ? rebIndexFactor : undefined,
  };
}
