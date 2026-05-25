/**
 * 시계열 예측 평가 지표 — 세 모델(MA-12 / ARIMA / LSTM) 공통.
 *
 * 입력:  actual[] 실제값, predicted[] 예측값 (length 동일, 한 쌍씩 매칭)
 * 출력:  MAPE(%), RMSE(원 단위 유지), R² (1=완벽, 0=평균예측, 음수=평균보다 못함)
 *
 * NaN/0 안전:
 *   · MAPE: actual=0 인 점은 제외 (division by zero 방어)
 *   · R²: SS_tot=0 (모든 actual 동일) 인 경우 R²=NaN 반환
 */

export interface MetricResult {
  mape: number;   // %
  rmse: number;   // 입력 단위 그대로 (예: 만원/㎡)
  r2: number;     // -∞ ~ 1
  n: number;      // 비교에 사용된 페어 수
}

export function calcMetrics(actual: number[], predicted: number[]): MetricResult {
  if (actual.length !== predicted.length) {
    throw new Error(
      `actual.length(${actual.length}) !== predicted.length(${predicted.length})`,
    );
  }
  if (actual.length === 0) {
    return { mape: NaN, rmse: NaN, r2: NaN, n: 0 };
  }

  // 1) MAPE — 0 제외
  let pctSum = 0;
  let pctCount = 0;
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i];
    const p = predicted[i];
    if (!Number.isFinite(a) || !Number.isFinite(p)) continue;
    if (Math.abs(a) < 1e-9) continue;
    pctSum += Math.abs((p - a) / a);
    pctCount += 1;
  }
  const mape = pctCount > 0 ? (pctSum / pctCount) * 100 : NaN;

  // 2) RMSE
  let sqSum = 0;
  let sqCount = 0;
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i];
    const p = predicted[i];
    if (!Number.isFinite(a) || !Number.isFinite(p)) continue;
    sqSum += (p - a) ** 2;
    sqCount += 1;
  }
  const rmse = sqCount > 0 ? Math.sqrt(sqSum / sqCount) : NaN;

  // 3) R² = 1 - SS_res / SS_tot
  const actualValid: number[] = [];
  const predValid: number[] = [];
  for (let i = 0; i < actual.length; i++) {
    if (Number.isFinite(actual[i]) && Number.isFinite(predicted[i])) {
      actualValid.push(actual[i]);
      predValid.push(predicted[i]);
    }
  }
  let r2 = NaN;
  if (actualValid.length >= 2) {
    const mean =
      actualValid.reduce((s, v) => s + v, 0) / actualValid.length;
    let ssRes = 0;
    let ssTot = 0;
    for (let i = 0; i < actualValid.length; i++) {
      ssRes += (actualValid[i] - predValid[i]) ** 2;
      ssTot += (actualValid[i] - mean) ** 2;
    }
    if (ssTot > 1e-12) {
      r2 = 1 - ssRes / ssTot;
    }
  }

  return { mape, rmse, r2, n: actualValid.length };
}

/** CSV 한 줄 포맷 (소수점 4자리) */
export function formatMetric(m: MetricResult): string {
  const f = (v: number) =>
    Number.isFinite(v) ? v.toFixed(4) : 'NaN';
  return `${f(m.mape)},${f(m.rmse)},${f(m.r2)},${m.n}`;
}
