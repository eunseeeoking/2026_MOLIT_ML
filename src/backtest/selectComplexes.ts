/**
 * 백테스트용 거래량 상위 5단지 자동 선정.
 *
 * 기준:
 *   1) 거래 건수 많은 단지 (시계열 노이즈 ↓)
 *   2) 월별 시계열 ≥ minMonths (기본 48 — 호출자가 minTrain+test 로 지정)
 *   3) 가장 최근 거래가 DB MAX(deal_date) 기준 24개월 이내 (운영중인 단지)
 *      ※ 시스템 날짜 기준 X — DB 데이터 cutoff (2025-04) 와 시스템 시계 어긋남 대응
 *
 * 출력: [{ id, name, sigunguCode, legalDong, tradeCount, monthSpan }, ...]
 */

import { prisma } from '../db';
import { fetchComplexTrades } from '../data/fetch';
import { toMonthlySeries } from '../data/preprocess';

export interface BacktestComplex {
  id: number;
  name: string;
  sigunguCode: string;
  legalDong: string;
  tradeCount: number;
  monthSpan: number;          // 월별 시계열 길이 (forward-fill 포함)
  lastDealYm: string;         // 최근 거래 월 (YYYY-MM)
}

export async function selectTopComplexes(opts: {
  topN?: number;             // 최종 선정 개수 (기본 5)
  minMonths?: number;        // 최소 월 시계열 길이 (기본 48)
  candidatePool?: number;    // SQL 1차 후보 수 (기본 50, 더 많이 뽑아 필터링)
  sigunguCode?: string;      // 특정 자치구로 제한 (선택)
  recentMonths?: number;     // DB MAX(deal_date) 기준 최근 N개월 이내 거래 (기본 24)
}): Promise<BacktestComplex[]> {
  const topN = opts.topN ?? 5;
  const minMonths = opts.minMonths ?? 48;
  const pool = opts.candidatePool ?? 50;
  const recentMonths = opts.recentMonths ?? 24;

  // DB 데이터의 최신 거래 월 — 시스템 시간과 다를 수 있음 (데이터 cutoff 가 1년 어긋남)
  const maxRow = await prisma.$queryRawUnsafe<Array<{ max_date: Date | null }>>(
    `SELECT MAX(deal_date) AS max_date FROM t_apt_trade`,
  );
  const maxDate = maxRow[0]?.max_date ? new Date(maxRow[0].max_date) : new Date();
  const cutoff = new Date(
    Date.UTC(maxDate.getUTCFullYear(), maxDate.getUTCMonth() - recentMonths, 1),
  );
  const cutoffYm = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}`;
  console.log(
    `[selectComplexes] DB max deal_date=${maxDate.toISOString().slice(0, 10)} → cutoff=${cutoffYm}`,
  );

  // 1차: 거래량 상위 N개 후보 (서울 한정 + sigungu_code 시작 11 default)
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      id: number;
      name: string;
      sigungu_code: string;
      legal_dong: string;
      cnt: bigint | number;
    }>
  >(
    `
    SELECT c.id, c.name, c.sigungu_code, c.legal_dong, COUNT(t.id) AS cnt
    FROM t_apt_complex c
    JOIN t_apt_trade t ON t.complex_id = c.id
    WHERE 1=1
      ${opts.sigunguCode ? 'AND c.sigungu_code = ?' : "AND c.sigungu_code LIKE '11%'"}
    GROUP BY c.id
    ORDER BY cnt DESC
    LIMIT ?
    `,
    ...(opts.sigunguCode ? [opts.sigunguCode, pool] : [pool]),
  );

  console.log(
    `[selectComplexes] 1차 SQL 후보 ${rows.length}개 → 시계열/최근거래 검증 중...`,
  );

  // 2차: 각 후보의 월별 시계열 길이 + 최근 거래 검증
  const qualified: BacktestComplex[] = [];
  let skipShortTrade = 0;
  let skipShortSeries = 0;
  let skipOldDeal = 0;
  for (const r of rows) {
    const trades = await fetchComplexTrades(r.id);
    if (trades.length < 30) {
      skipShortTrade += 1;
      continue;
    }
    const series = toMonthlySeries(trades);
    if (series.length < minMonths) {
      skipShortSeries += 1;
      continue;
    }

    const lastYm = series[series.length - 1].ym;
    if (lastYm < cutoffYm) {
      skipOldDeal += 1;
      continue;
    }

    qualified.push({
      id: r.id,
      name: r.name,
      sigunguCode: r.sigungu_code,
      legalDong: r.legal_dong,
      tradeCount: Number(r.cnt),
      monthSpan: series.length,
      lastDealYm: lastYm,
    });

    if (qualified.length >= topN) break;
  }

  console.log(
    `[selectComplexes] skip stats: shortTrade=${skipShortTrade}, ` +
      `shortSeries=${skipShortSeries}, oldDeal=${skipOldDeal} ` +
      `→ qualified=${qualified.length}/${topN}`,
  );

  return qualified;
}
