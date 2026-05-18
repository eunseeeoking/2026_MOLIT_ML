import type { TradeRow } from './fetch';
import type { AreaBucket, AgeBucket } from '@prisma/client';

/**
 * 거래 데이터 전처리 — LSTM 학습용 시계열로 변환.
 *
 * 흐름:
 *   1. 각 거래의 m²당 단가 계산 (만원/㎡)
 *   2. 월별로 group → 중위값(median) 사용 (평균은 이상치에 민감)
 *   3. IQR 1.5배 밖의 거래는 제외
 *   4. 누락 월은 직전 값으로 보간(forward-fill) — LSTM 학습 시 결측 X
 */

export interface MonthlyPoint {
  ym: string; // "YYYY-MM"
  pricePerM2: number; // 만원/㎡
  sampleCount: number;
}

export function pricePerM2Manwon(t: TradeRow): number {
  return t.areaM2 > 0 ? t.priceManwon / t.areaM2 : 0;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function quantile(sortedArr: number[], q: number): number {
  if (sortedArr.length === 0) return 0;
  const pos = (sortedArr.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sortedArr[base + 1] !== undefined
    ? sortedArr[base] + rest * (sortedArr[base + 1] - sortedArr[base])
    : sortedArr[base];
}

function ymOf(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function nextYm(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 1)); // m 은 0-based 다음달
  return ymOf(d);
}

/** 평형 구간 매핑 */
export function bucketArea(areaM2: number): AreaBucket {
  if (areaM2 <= 60) return 'SMALL';
  if (areaM2 <= 85) return 'MEDIUM';
  if (areaM2 <= 135) return 'LARGE_MID';
  return 'LARGE';
}

/** 연식 구간 매핑 — 기준 연도는 거래 시점이 아니라 학습 시점 기준 */
export function bucketAge(builtYear: number | null, baseYear: number): AgeBucket {
  if (builtYear == null) return 'OLD';
  const age = baseYear - builtYear;
  if (age <= 10) return 'NEW';
  if (age <= 20) return 'SEMI_NEW';
  if (age <= 30) return 'MID';
  return 'OLD';
}

/**
 * 거래 array → 월별 m²당 단가 시계열.
 *  - IQR 1.5 outlier 제거
 *  - 월별 중위값 사용
 *  - 누락 월은 forward-fill
 */
export function toMonthlySeries(trades: TradeRow[]): MonthlyPoint[] {
  if (trades.length === 0) return [];

  // 1) m²당 단가 + 이상치 컷
  const prices = trades.map(pricePerM2Manwon).filter((v) => v > 0);
  const sorted = [...prices].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;

  // 2) 월별 group
  const byYm = new Map<string, number[]>();
  for (const t of trades) {
    const p = pricePerM2Manwon(t);
    if (p < lower || p > upper) continue;
    const ym = ymOf(t.dealDate);
    const arr = byYm.get(ym) ?? [];
    arr.push(p);
    byYm.set(ym, arr);
  }
  if (byYm.size === 0) return [];

  // 3) 월별 중위값
  const points: MonthlyPoint[] = [];
  for (const [ym, arr] of byYm) {
    points.push({ ym, pricePerM2: median(arr), sampleCount: arr.length });
  }
  points.sort((a, b) => a.ym.localeCompare(b.ym));

  // 4) 누락 월 forward-fill
  const filled: MonthlyPoint[] = [];
  let cursor = points[0].ym;
  const last = points[points.length - 1].ym;
  let idx = 0;
  let prevPrice = points[0].pricePerM2;
  while (cursor <= last) {
    if (idx < points.length && points[idx].ym === cursor) {
      filled.push(points[idx]);
      prevPrice = points[idx].pricePerM2;
      idx += 1;
    } else {
      filled.push({ ym: cursor, pricePerM2: prevPrice, sampleCount: 0 });
    }
    cursor = nextYm(cursor);
  }
  return filled;
}

/** 슬라이딩 윈도우 — [windowSize 입력] → [horizon 후 단일 타겟] */
export interface TrainExample {
  input: number[]; // windowSize 개 정규화된 가격
  target: number; // horizon 후 정규화된 가격
}

export function buildTrainExamples(
  series: MonthlyPoint[],
  windowSize: number,
  horizon: number,
): { examples: TrainExample[]; scale: { mean: number; std: number } } {
  const prices = series.map((p) => p.pricePerM2);
  if (prices.length < windowSize + horizon) return { examples: [], scale: { mean: 0, std: 1 } };

  // 정규화 (z-score)
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance =
    prices.reduce((s, v) => s + (v - mean) ** 2, 0) / prices.length;
  const std = Math.sqrt(variance) || 1;
  const z = prices.map((v) => (v - mean) / std);

  const examples: TrainExample[] = [];
  for (let i = 0; i + windowSize + horizon <= z.length; i++) {
    examples.push({
      input: z.slice(i, i + windowSize),
      target: z[i + windowSize + horizon - 1],
    });
  }
  return { examples, scale: { mean, std } };
}
