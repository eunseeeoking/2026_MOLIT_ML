/**
 * t_training_result.confidence 백필 (재학습 X)
 *
 *   실행: npm run train:backfill [-- --dry] [-- --force]
 *
 *   동작:
 *     - confidence IS NULL AND mape IS NOT NULL 인 모든 row 대상
 *     - calcLstmConfidence(mape, sampleCount) 산출 → DB UPDATE (0~1 범위)
 *     - --dry: SQL 실행 없이 시뮬레이션만 (변경 row 수 출력)
 *     - --force: confidence 가 이미 값 있어도 재계산 적용 (mape 가 더 최신일 때)
 *
 *   목적 (2026-05-27):
 *     train.ts:99 가 confidence: null 박혀있어서 t_training_result 2,143건 모두 NULL.
 *     server lstm.ts 가 mape/sampleCount 기반 동적 산출하므로 UI 영향은 이미 해결됨.
 *     이 backfill 은 DB row 자체를 정합화 하여 분석/리포팅 시 일관성 확보용.
 *
 *   효과:
 *     - npm run db:snapshot 의 confidence 통계 정확해짐
 *     - 추후 ML repo 외부 분석 도구에서 confidence 직접 사용 가능
 *     - server lstm.ts 가 fast path (NULL 검사 X) 로 동작 → 미세한 성능 개선
 */
import 'dotenv/config';
import { prisma, disconnect } from '../db';
import { calcLstmConfidence } from '../utils/confidence';

const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');

async function main() {
  console.log(`\n🔧 confidence 백필 시작 (dry=${DRY}, force=${FORCE})\n`);
  console.log('='.repeat(70));

  // 대상 row 조회
  const whereClause = FORCE
    ? { mape: { not: null } }
    : { confidence: null, mape: { not: null } };

  const rows = await prisma.trainingResult.findMany({
    where: whereClause,
    select: { id: true, mape: true, sampleCount: true, confidence: true },
  });

  console.log(`대상 row: ${rows.length.toLocaleString()}건`);

  if (rows.length === 0) {
    console.log('✅ 백필할 row 없음 (모두 이미 채워짐 or mape NULL)');
    await disconnect();
    return;
  }

  let applied = 0;
  let skipped = 0;
  let unchanged = 0;

  // 통계 수집
  const distribution: Record<string, number> = {
    '50': 0, '51-60': 0, '61-70': 0, '71-80': 0, '81-90': 0, '91-95': 0,
  };

  for (const [idx, row] of rows.entries()) {
    const calc = calcLstmConfidence(row.mape, row.sampleCount);

    if (calc.forDb == null) {
      skipped++;
      continue;
    }

    // FORCE 모드에서 기존 값과 동일하면 skip (불필요한 update 회피)
    if (FORCE && row.confidence != null && Math.abs(row.confidence - calc.forDb) < 0.005) {
      unchanged++;
      continue;
    }

    // 분포 집계
    const d = calc.display!;
    if (d === 50) distribution['50']++;
    else if (d <= 60) distribution['51-60']++;
    else if (d <= 70) distribution['61-70']++;
    else if (d <= 80) distribution['71-80']++;
    else if (d <= 90) distribution['81-90']++;
    else distribution['91-95']++;

    if (!DRY) {
      await prisma.trainingResult.update({
        where: { id: row.id },
        data: { confidence: calc.forDb },
      });
    }
    applied++;

    if ((idx + 1) % 200 === 0) {
      console.log(`  ${idx + 1}/${rows.length}건 처리 중...`);
    }
  }

  console.log('');
  console.log('='.repeat(70));
  console.log(`📊 결과`);
  console.log('─'.repeat(70));
  console.log(`  ${DRY ? '시뮬레이션' : '적용'}됨: ${applied.toLocaleString()}건`);
  console.log(`  skip (mape NULL 등): ${skipped.toLocaleString()}건`);
  if (FORCE) {
    console.log(`  변경 없음 (동일값): ${unchanged.toLocaleString()}건`);
  }

  console.log('\n  분포:');
  for (const [label, count] of Object.entries(distribution)) {
    const ratio = applied > 0 ? (count / applied) * 100 : 0;
    const bar = '█'.repeat(Math.round(ratio / 2));
    console.log(`    ${label.padEnd(8)}  ${String(count).padStart(5)}  ${ratio.toFixed(1).padStart(5)}%  ${bar}`);
  }

  if (DRY) {
    console.log('\n  ℹ️  --dry 모드 — 실제 UPDATE 안 함. 적용하려면:');
    console.log('     npm run train:backfill');
  }

  console.log('');
  await disconnect();
}

main().catch(async (e) => {
  console.error('백필 실패:', e);
  await disconnect();
  process.exit(1);
});
