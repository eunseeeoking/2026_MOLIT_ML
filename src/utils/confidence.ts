/**
 * LSTM 학습 결과 confidence 산출 (server 와 동일 산식)
 *
 *   문제 (2026-05-27 진단):
 *     - train.ts:99 가 confidence: null 을 하드코딩으로 저장 → TODO 마커
 *     - server/src/routes/domains/lstm.ts 가 ?? 0.7 폴백 → 모든 단지 70 픽스
 *     → Depth 3 도넛 신뢰도 50/70 픽스 이슈의 ML side root cause
 *
 *   산식 (MAPE 기반, 학술 근거):
 *     base = 100 - mape × 1.5     ← 예측 오차가 작을수록 높음
 *     bonus = log10(sampleCount) × 5  ← 학습 샘플 풍부할수록 추가 가점
 *     confidence = clamp(50, 95, round(base + bonus))
 *
 *   예시:
 *     MAPE 5%,  sample 1000 → 100 - 7.5 + 15 = 107.5 → 95 (cap)
 *     MAPE 12%, sample 500  → 100 - 18  + 13.5 ≈ 95.5 → 95 (cap)
 *     MAPE 20%, sample 100  → 100 - 30  + 10 ≈ 80
 *     MAPE 30%, sample 50   → 100 - 45  + 8.5 ≈ 64
 *     MAPE 50%, sample 20   → 100 - 75  + 6.5 ≈ 50 (floor)
 *     MAPE 106%, sample 40  → 100 - 159 + 8  ≈ -51 → 50 (floor)
 *
 *   NULL/0 처리:
 *     mape 또는 sampleCount NULL/0 → null 반환 (저장 시 null 그대로)
 *     server 측에서는 ?? 0.7 폴백 → 70 표시 (안전망)
 *
 *   ★ 반환 단위 주의:
 *     DB 저장용은 0~1 범위 (t_training_result.confidence Float) → / 100
 *     server 측 응답용은 0~100 정수 → server 가 × 100 후 round
 */

export interface ConfidenceResult {
  /** DB 저장용 0~1 범위. null 이면 산출 불가 (저장 안 함) */
  forDb: number | null;
  /** 사람용 0~100 정수 (로그 출력) */
  display: number | null;
  /** 산식 입력 요약 (로그용) */
  detail: string;
}

export function calcLstmConfidence(
  mape: number | null,
  sampleCount: number | null,
): ConfidenceResult {
  if (mape == null || sampleCount == null || sampleCount <= 0) {
    return {
      forDb: null,
      display: null,
      detail: '산출 불가 (mape 또는 sampleCount 누락)',
    };
  }
  const base = 100 - mape * 1.5;
  const bonus = Math.log10(Math.max(1, sampleCount)) * 5;
  const raw = base + bonus;
  const display = Math.min(95, Math.max(50, Math.round(raw)));
  const forDb = display / 100;
  return {
    forDb,
    display,
    detail: `MAPE ${mape.toFixed(1)}%, 샘플 ${sampleCount.toLocaleString()}건 → ${display}/100`,
  };
}
