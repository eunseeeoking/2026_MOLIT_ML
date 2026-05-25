/**
 * R-ONE 부동산원 실거래지수 기반 시계열 정규화 (ML repo, 2026-05-24 신규)
 *
 *  ▷ 핵심 아이디어
 *    LSTM 이 학습하는 값 = "실거래가 ÷ 부동산원 지수 × 100"
 *      → 시장 전체 추세(거시 노이즈) 제거
 *      → 동/단지 고유 변동만 학습
 *
 *    예측 복원:
 *      LSTM_정규화_예측 × (latestIndex / 100) = 실제 만원/㎡ 예측
 *
 *  ▷ 백테스트 vs 운영
 *    백테스트: train 마지막 ym 의 index 만 사용 (운영 시뮬레이션 — 보수적)
 *    운영:     현재 시점의 latest index 사용
 *
 *  ▷ 의존성
 *    t_reb_price_index 테이블 (server repo 가 관리, ML 은 read-only)
 *    @@unique([sigungu_code, ym])
 *
 *  ▷ Fallback
 *    sigunguCode 매칭 실패 / DB row 없음 → 정규화 미적용 (원본 시계열 반환)
 *    호출처는 enableReb 토글로 끄거나, 데이터 없으면 자동 fallback
 */

import { prisma } from '../db';
import type { MonthlyPoint } from './preprocess';

/* ─── 인덱스 캐시 (단일 백테스트 run 내 메모리) ────────── */

const indexCache = new Map<string, Map<string, number>>(); // sigunguCode → (ym → indexValue)

/**
 * 특정 시군구의 모든 R-ONE 지수 로드 (한 번만 DB 조회).
 *  - 백테스트는 같은 sigungu 의 시계열을 여러 번 정규화/역정규화 → 캐시 효과 큼
 *  - row 0건 → 빈 Map (호출처가 fallback)
 */
export async function preloadIndex(sigunguCode: string): Promise<Map<string, number>> {
  const cached = indexCache.get(sigunguCode);
  if (cached) return cached;

  const rows = await prisma.$queryRawUnsafe<Array<{ ym: string; index_value: number }>>(
    `SELECT ym, index_value FROM t_reb_price_index WHERE sigungu_code = ? ORDER BY ym ASC`,
    sigunguCode,
  );

  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(r.ym, Number(r.index_value));
  }
  indexCache.set(sigunguCode, map);
  if (map.size === 0) {
    console.warn(`[rebNormalize] no index for sigungu=${sigunguCode} — fallback to raw prices`);
  }
  return map;
}

/**
 * 시계열 정규화 — 각 month 의 price 를 해당 ym 의 R-ONE 지수로 나눔.
 *
 *  normalized(ym) = price(ym) / (index(ym) / 100)
 *
 *  - index 미발견 ym 은 가장 가까운 이전 index 사용 (forward-fill)
 *  - 시계열 전체에 대해 index 가 0건이면 원본 그대로 반환
 *  - 반환값의 단위는 여전히 "만원/㎡" 이지만 "기준점 100" 으로 정규화된 값
 */
export function normalizeSeries(
  series: MonthlyPoint[],
  indexMap: Map<string, number>,
): { normalized: MonthlyPoint[]; coverage: number } {
  if (indexMap.size === 0) return { normalized: series, coverage: 0 };

  // ym → indexValue (forward-fill)
  const sortedYms = [...indexMap.keys()].sort();
  let lastIndex: number | null = null;

  const normalized: MonthlyPoint[] = [];
  let covered = 0;

  for (const p of series) {
    let idx = indexMap.get(p.ym);
    if (idx === undefined) {
      // forward-fill: 가장 가까운 이전 ym 의 index 사용
      // sortedYms 에서 p.ym 이하 최대값 탐색 (선형이지만 series 크기 작음)
      for (const ym of sortedYms) {
        if (ym <= p.ym) lastIndex = indexMap.get(ym) ?? lastIndex;
        else break;
      }
      idx = lastIndex ?? undefined;
    } else {
      lastIndex = idx;
    }

    if (idx === undefined || idx <= 0) {
      // 어떤 fallback 도 못 잡으면 원본 유지
      normalized.push(p);
      continue;
    }

    const factor = idx / 100;
    normalized.push({
      ym: p.ym,
      pricePerM2: p.pricePerM2 / factor,
      sampleCount: p.sampleCount,
    });
    covered++;
  }

  return { normalized, coverage: covered / series.length };
}

/**
 * 예측값 역정규화 — LSTM 정규화 예측을 실제 가격으로 복원.
 *
 *  실제예측(ym') = LSTM_정규화예측(ym') × (indexFactor / 100)
 *
 *  ▷ indexFactor 선택 정책
 *    백테스트:  train 마지막 ym 의 index (운영 시뮬레이션 — 보수적)
 *    운영:      latestIndex (현재 시점)
 *
 *  - indexFactor 가 0 또는 음수면 정규화 미적용 (원본 그대로 반환)
 */
export function denormalizePredictions(
  predictions: number[],
  indexFactor: number,
): number[] {
  if (!Number.isFinite(indexFactor) || indexFactor <= 0) return predictions;
  const factor = indexFactor / 100;
  return predictions.map((v) => v * factor);
}

/**
 * 가장 가까운 ym 의 index 조회 (forward-fill 단건).
 *  - 운영 LSTM 예측에서 latestIndex 가 필요할 때 사용
 *  - ym ≤ targetYm 중 가장 큰 row 의 index_value 반환
 */
export function getNearestIndex(
  indexMap: Map<string, number>,
  targetYm: string,
): number | null {
  if (indexMap.size === 0) return null;
  const sortedYms = [...indexMap.keys()].sort();
  let last: number | null = null;
  for (const ym of sortedYms) {
    if (ym <= targetYm) last = indexMap.get(ym) ?? last;
    else break;
  }
  return last;
}

/**
 * 캐시 초기화 (테스트/스크립트 종료 시).
 */
export function clearIndexCache() {
  indexCache.clear();
}
