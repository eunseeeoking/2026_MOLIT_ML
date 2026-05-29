/**
 * 현재 학습 결과 통계 출력 (재학습 X, 읽기 전용)
 *
 *   실행: npm run train:stats
 *
 *   목적:
 *     - D-2 시점에 재학습 결정 전 현황 파악
 *     - 어떤 MODEL_VERSION 이 얼마나 잘 학습됐는지
 *     - MAPE 50% 초과 비율 = 학습 실패 단지 비율
 *     - backfill 적용 가능한 row 수 추정
 *
 *   체크 항목:
 *     [1] 전체 row 수 + confidence NULL 비율
 *     [2] MAPE 분포 히스토그램
 *     [3] sampleCount 분포 히스토그램
 *     [4] modelVersion 별 평균 MAPE
 *     [5] backfill 적용 시뮬레이션 결과 분포
 */
import 'dotenv/config';
import { prisma, disconnect } from '../db';
import { calcLstmConfidence } from '../utils/confidence';

interface Bucket {
  label: string;
  range: [number, number];
  count: number;
}

async function main() {
  console.log('\n📊 LSTM 학습 결과 통계\n');
  console.log('='.repeat(70));

  // [1] 전체 + confidence NULL
  const total = await prisma.trainingResult.count();
  const nullConf = await prisma.trainingResult.count({ where: { confidence: null } });
  const nullMape = await prisma.trainingResult.count({ where: { mape: null } });
  console.log(`\n[1] 전체 학습 결과`);
  console.log('─'.repeat(70));
  console.log(`    총 row 수             : ${total.toLocaleString()}`);
  console.log(`    confidence NULL        : ${nullConf.toLocaleString()} (${((nullConf / total) * 100).toFixed(1)}%)`);
  console.log(`    mape NULL              : ${nullMape.toLocaleString()} (${((nullMape / total) * 100).toFixed(1)}%)`);
  console.log(`    backfill 가능 (mape 有): ${(total - nullMape).toLocaleString()} (${(((total - nullMape) / total) * 100).toFixed(1)}%)`);

  // [2] MAPE 분포
  console.log(`\n[2] MAPE 분포 (학습 품질 지표)`);
  console.log('─'.repeat(70));
  const mapeBuckets: Bucket[] = [
    { label: '0~5% (우수)',     range: [0, 5],     count: 0 },
    { label: '5~10% (양호)',    range: [5, 10],    count: 0 },
    { label: '10~20% (보통)',   range: [10, 20],   count: 0 },
    { label: '20~50% (나쁨)',   range: [20, 50],   count: 0 },
    { label: '50~100% (실패)',  range: [50, 100],  count: 0 },
    { label: '>100% (붕괴)',    range: [100, 1e9], count: 0 },
  ];
  const mapeRows = await prisma.$queryRaw<{ mape: number }[]>`
    SELECT mape FROM t_training_result WHERE mape IS NOT NULL
  `;
  for (const r of mapeRows) {
    const m = Number(r.mape);
    for (const b of mapeBuckets) {
      if (m >= b.range[0] && m < b.range[1]) {
        b.count++;
        break;
      }
    }
  }
  const validMape = mapeRows.length;
  for (const b of mapeBuckets) {
    const ratio = validMape > 0 ? (b.count / validMape) * 100 : 0;
    const bar = '█'.repeat(Math.round(ratio / 2));
    console.log(
      `    ${b.label.padEnd(18)}  ${String(b.count).padStart(6)}  ${ratio.toFixed(1).padStart(5)}%  ${bar}`,
    );
  }

  const mapeMean = mapeRows.reduce((s, r) => s + Number(r.mape), 0) / Math.max(1, validMape);
  console.log(`\n    평균 MAPE              : ${mapeMean.toFixed(1)}%`);
  console.log(`    > 50% (학습 실패)      : ${mapeBuckets[4].count + mapeBuckets[5].count}건 (${(((mapeBuckets[4].count + mapeBuckets[5].count) / validMape) * 100).toFixed(1)}%)`);

  // [3] sampleCount 분포
  console.log(`\n[3] sampleCount 분포 (학습 데이터 풍부도)`);
  console.log('─'.repeat(70));
  const sampleBuckets: Bucket[] = [
    { label: '0~20',     range: [0, 20],     count: 0 },
    { label: '20~50',    range: [20, 50],    count: 0 },
    { label: '50~100',   range: [50, 100],   count: 0 },
    { label: '100~500',  range: [100, 500],  count: 0 },
    { label: '500~1000', range: [500, 1000], count: 0 },
    { label: '>1000',    range: [1000, 1e9], count: 0 },
  ];
  const sampleRows = await prisma.$queryRaw<{ sample_count: bigint }[]>`
    SELECT sample_count FROM t_training_result
  `;
  for (const r of sampleRows) {
    const s = Number(r.sample_count);
    for (const b of sampleBuckets) {
      if (s >= b.range[0] && s < b.range[1]) {
        b.count++;
        break;
      }
    }
  }
  for (const b of sampleBuckets) {
    const ratio = sampleRows.length > 0 ? (b.count / sampleRows.length) * 100 : 0;
    const bar = '█'.repeat(Math.round(ratio / 2));
    console.log(
      `    ${b.label.padEnd(12)}  ${String(b.count).padStart(6)}  ${ratio.toFixed(1).padStart(5)}%  ${bar}`,
    );
  }

  // [4] modelVersion 별 평균 MAPE
  console.log(`\n[4] modelVersion 별 통계`);
  console.log('─'.repeat(70));
  const byVersion = await prisma.$queryRaw<
    { model_version: string; cnt: bigint; avg_mape: number | null }[]
  >`
    SELECT model_version, COUNT(*) AS cnt, AVG(mape) AS avg_mape
    FROM t_training_result
    GROUP BY model_version
    ORDER BY cnt DESC
  `;
  console.log(`    버전              row 수    평균 MAPE`);
  for (const v of byVersion) {
    console.log(
      `    ${v.model_version.padEnd(18)}  ${String(v.cnt).padStart(6)}    ${
        v.avg_mape != null ? Number(v.avg_mape).toFixed(1) + '%' : '-'
      }`,
    );
  }

  // [5] backfill 시뮬레이션
  console.log(`\n[5] backfill 시뮬레이션 (mape + sampleCount 기반 confidence 산출)`);
  console.log('─'.repeat(70));
  const backfillCandidates = await prisma.$queryRaw<
    { mape: number; sample_count: bigint }[]
  >`
    SELECT mape, sample_count FROM t_training_result WHERE mape IS NOT NULL
  `;
  const confBuckets: Bucket[] = [
    { label: '50 (최저)',    range: [50, 51],   count: 0 },
    { label: '51~60',        range: [51, 60],   count: 0 },
    { label: '60~70',        range: [60, 70],   count: 0 },
    { label: '70~80',        range: [70, 80],   count: 0 },
    { label: '80~90',        range: [80, 90],   count: 0 },
    { label: '90~95 (최고)', range: [90, 96],   count: 0 },
  ];
  for (const r of backfillCandidates) {
    const c = calcLstmConfidence(Number(r.mape), Number(r.sample_count));
    if (c.display == null) continue;
    for (const b of confBuckets) {
      if (c.display >= b.range[0] && c.display < b.range[1]) {
        b.count++;
        break;
      }
    }
  }
  for (const b of confBuckets) {
    const ratio = backfillCandidates.length > 0 ? (b.count / backfillCandidates.length) * 100 : 0;
    const bar = '█'.repeat(Math.round(ratio / 2));
    console.log(
      `    ${b.label.padEnd(15)}  ${String(b.count).padStart(6)}  ${ratio.toFixed(1).padStart(5)}%  ${bar}`,
    );
  }

  console.log('\n' + '='.repeat(70));
  console.log('💡 다음 액션:');
  console.log('  • backfill 실행 → npm run train:backfill   (재학습 X, 30초)');
  console.log('  • 재학습 (위험)  → npm run train:once       (수십분)');
  console.log('');

  await disconnect();
}

main().catch(async (e) => {
  console.error('통계 출력 실패:', e);
  await disconnect();
  process.exit(1);
});
