import { prisma } from '../db';

/**
 * DB 에서 학습용 거래 데이터를 가져온다.
 *  - 단지 단위 또는 (시군구·법정동·평형·연식) 구간 단위
 *  - 거래는 t_apt_trade 만 사용 (전월세는 별도 모델 — 본 모듈은 매매가만 학습)
 */

export interface TradeRow {
  dealDate: Date;
  priceManwon: number;
  areaM2: number;
  builtYear: number | null;
}

export interface ComplexCandidate {
  id: number;
  aptSeq: string | null;
  name: string;
  sigunguCode: string;
  legalDong: string;
  builtYear: number | null;
  tradeCount: number;
}

/** 학습 가치 있는 단지 목록 (최소 거래 건수 이상) */
export async function listTrainableComplexes(opts: {
  minTrades?: number;
  sigunguCode?: string;
  limit?: number;
}): Promise<ComplexCandidate[]> {
  const minTrades = opts.minTrades ?? 20;
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      id: number;
      apt_seq: string | null;
      name: string;
      sigungu_code: string;
      legal_dong: string;
      built_year: number | null;
      cnt: bigint | number;
    }>
  >(
    `
    SELECT c.id, c.apt_seq, c.name, c.sigungu_code, c.legal_dong, c.built_year,
           COUNT(t.id) AS cnt
    FROM t_apt_complex c
    JOIN t_apt_trade t ON t.complex_id = c.id
    WHERE 1=1
      ${opts.sigunguCode ? 'AND c.sigungu_code = ?' : ''}
    GROUP BY c.id
    HAVING cnt >= ?
    ORDER BY cnt DESC
    ${opts.limit ? 'LIMIT ?' : ''}
    `,
    ...(opts.sigunguCode
      ? opts.limit
        ? [opts.sigunguCode, minTrades, opts.limit]
        : [opts.sigunguCode, minTrades]
      : opts.limit
        ? [minTrades, opts.limit]
        : [minTrades]),
  );

  return rows.map((r) => ({
    id: r.id,
    aptSeq: r.apt_seq,
    name: r.name,
    sigunguCode: r.sigungu_code,
    legalDong: r.legal_dong,
    builtYear: r.built_year,
    tradeCount: Number(r.cnt),
  }));
}

/** 특정 단지의 모든 거래 (시계열 순) */
export async function fetchComplexTrades(complexId: number): Promise<TradeRow[]> {
  return prisma.aptTrade.findMany({
    where: { complexId },
    orderBy: { dealDate: 'asc' },
    select: {
      dealDate: true,
      priceManwon: true,
      areaM2: true,
      builtYear: true,
    },
  });
}

/** 구간(시군구·법정동·평형구간·연식구간) 단위 거래 — 단지 부족 시 fallback */
export async function fetchBucketTrades(opts: {
  sigunguCode: string;
  legalDong: string;
  areaMin: number; // ㎡ 하한 (inclusive)
  areaMax: number; // ㎡ 상한 (exclusive)
  builtYearMin: number; // 연식 범위 (inclusive)
  builtYearMax: number; // 연식 범위 (exclusive — 신축이 큰 값)
}): Promise<TradeRow[]> {
  return prisma.aptTrade.findMany({
    where: {
      areaM2: { gte: opts.areaMin, lt: opts.areaMax },
      builtYear: { gte: opts.builtYearMin, lt: opts.builtYearMax },
      complex: {
        sigunguCode: opts.sigunguCode,
        legalDong: opts.legalDong,
      },
    },
    orderBy: { dealDate: 'asc' },
    select: {
      dealDate: true,
      priceManwon: true,
      areaM2: true,
      builtYear: true,
    },
  });
}
