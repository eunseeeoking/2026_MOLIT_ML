import 'dotenv/config';
import {
  listTrainableComplexes,
  fetchComplexTrades,
} from './data/fetch';
import {
  bucketArea,
  bucketAge,
  buildTrainExamples,
  toMonthlySeries,
} from './data/preprocess';
import { trainLstm, predictNext } from './models/lstm';
import { upsertTrainingResult } from './repository/trainingResultRepository';
import { disconnect } from './db';

/**
 * 학습 파이프라인 entry point.
 *  - npm run train         : 모든 학습 가치 있는 단지를 무한 루프로 학습
 *  - npm run train:one     : 한 번만 순회 후 종료
 *
 * 환경변수:
 *   MIN_SAMPLES_PER_BUCKET (default 20)
 *   WINDOW_SIZE            (default 24)
 *   HORIZON_MONTHS         (default 36)
 *   MODEL_VERSION          (default lstm-v1)
 */

const ONCE = process.argv.includes('--once');
const MIN_TRADES = Number(process.env.MIN_SAMPLES_PER_BUCKET) || 20;
const WINDOW = Number(process.env.WINDOW_SIZE) || 24;
const HORIZON = Number(process.env.HORIZON_MONTHS) || 36;
const MODEL_VERSION = process.env.MODEL_VERSION || 'lstm-v1';
const LIMIT = Number(process.env.LIMIT) || 0; // 0 = no limit

async function trainOneComplex(complexId: number): Promise<{
  status: 'ok' | 'skip-insufficient' | 'error';
  reason?: string;
}> {
  const trades = await fetchComplexTrades(complexId);
  if (trades.length < WINDOW + HORIZON + 4) {
    return { status: 'skip-insufficient', reason: `only ${trades.length} trades` };
  }

  const series = toMonthlySeries(trades);
  if (series.length < WINDOW + HORIZON + 2) {
    return { status: 'skip-insufficient', reason: `series ${series.length} months` };
  }

  const { examples, scale } = buildTrainExamples(series, WINDOW, HORIZON);
  if (examples.length < 10) {
    return { status: 'skip-insufficient', reason: `${examples.length} examples` };
  }

  const { model, mae, mape } = await trainLstm(examples, {
    windowSize: WINDOW,
    epochs: 30,
  });

  // 최근 윈도우로 3년 예측 (단일 horizon=HORIZON)
  const recentZ = series
    .slice(-WINDOW)
    .map((p) => (p.pricePerM2 - scale.mean) / scale.std);
  const predZ = await predictNext(model, recentZ);
  const predicted3y = predZ * scale.std + scale.mean;

  // 메타 정보를 단지 첫 거래에서 (대표) 추출
  const lastTrade = trades[trades.length - 1];
  const areaBucket = bucketArea(lastTrade.areaM2);
  const baseYear = lastTrade.dealDate.getUTCFullYear();
  const ageBucket = bucketAge(lastTrade.builtYear, baseYear);

  // 단지 소속 시군구·법정동 조회 (DB 한 번 더 호출보다 trades 에서 못 가져오니 별도)
  // 간단히 fetchComplexTrades 가 complex 정보 함께 받게 확장하거나, 여기서 query.
  // 일단 간단히 trade 1건이 complex_id 만 갖고 있으니 별도 lookup 추가:
  const { prisma } = await import('./db');
  const c = await prisma.aptComplex.findUnique({
    where: { id: complexId },
    select: { sigunguCode: true, legalDong: true },
  });
  if (!c) return { status: 'error', reason: 'complex not found' };

  const currentPricePerM2 = series[series.length - 1].pricePerM2;
  const expectedReturn3y =
    currentPricePerM2 > 0
      ? ((predicted3y - currentPricePerM2) / currentPricePerM2) * 100
      : null;

  await upsertTrainingResult({
    complexId,
    sigunguCode: c.sigunguCode,
    legalDong: c.legalDong,
    areaBucket,
    ageBucket,
    baseDate: lastTrade.dealDate,
    currentPricePerM2,
    predicted1yPricePerM2: null, // (선택 — 별도 모델 필요)
    predicted3yPricePerM2: predicted3y,
    expectedReturn3y,
    confidence: null, // 추후 변동성 기반 산출
    mae,
    mape,
    sampleCount: examples.length,
    modelVersion: MODEL_VERSION,
    modelMeta: {
      window: WINDOW,
      horizon: HORIZON,
      scale,
    },
  });

  model.dispose();
  return { status: 'ok' };
}

async function runOnePass(): Promise<{ ok: number; skip: number; err: number }> {
  const complexes = await listTrainableComplexes({
    minTrades: MIN_TRADES,
    limit: LIMIT || undefined,
  });
  console.log(`[train] candidates: ${complexes.length} (minTrades=${MIN_TRADES})`);

  let ok = 0;
  let skip = 0;
  let err = 0;

  for (const [idx, c] of complexes.entries()) {
    const tag = `[${idx + 1}/${complexes.length}] ${c.name} (id=${c.id})`;
    try {
      const r = await trainOneComplex(c.id);
      if (r.status === 'ok') {
        ok += 1;
        if ((idx + 1) % 10 === 0) console.log(`${tag} OK`);
      } else if (r.status === 'skip-insufficient') {
        skip += 1;
      } else {
        err += 1;
        console.warn(`${tag} ERR ${r.reason}`);
      }
    } catch (e) {
      err += 1;
      console.error(`${tag} EXCEPTION`, e instanceof Error ? e.message : e);
    }
  }
  return { ok, skip, err };
}

async function main(): Promise<void> {
  console.log(
    `[train] starting (once=${ONCE}, window=${WINDOW}, horizon=${HORIZON}, model=${MODEL_VERSION})`,
  );

  if (ONCE) {
    const r = await runOnePass();
    console.log(`[train] done: ok=${r.ok} skip=${r.skip} err=${r.err}`);
    await disconnect();
    return;
  }

  // 무한 루프 — 한 번 끝나면 N분 쉬고 다시
  const sleepMs = 30 * 60 * 1000; // 30분
  let pass = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    pass += 1;
    console.log(`[train] pass ${pass} starting at ${new Date().toISOString()}`);
    try {
      const r = await runOnePass();
      console.log(`[train] pass ${pass} done: ok=${r.ok} skip=${r.skip} err=${r.err}`);
    } catch (e) {
      console.error(`[train] pass ${pass} fatal`, e);
    }
    console.log(`[train] sleeping ${sleepMs / 60000} min...`);
    await new Promise((r) => setTimeout(r, sleepMs));
  }
}

main().catch(async (e) => {
  console.error('[train] fatal', e);
  await disconnect();
  process.exit(1);
});
