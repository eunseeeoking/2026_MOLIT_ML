import 'dotenv/config';
import { prisma } from './src/db';

async function analyzeTradeDistribution() {
  console.log('=== 거래 데이터 분포 분석 ===\n');

  // 1. 전체 통계
  const allComplexes = await prisma.$queryRawUnsafe<
    Array<{ id: number; name: string; cnt: bigint | number }>
  >(
    `
    SELECT c.id, c.name, COUNT(t.id) AS cnt
    FROM t_apt_complex c
    LEFT JOIN t_apt_trade t ON t.complex_id = c.id
    GROUP BY c.id
    ORDER BY cnt DESC
    `
  );

  const tradeCounts = allComplexes.map((c) => Number(c.cnt));
  const total = tradeCounts.reduce((a, b) => a + b, 0);
  const avg = total / tradeCounts.length;
  const sorted = [...tradeCounts].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const q25 = sorted[Math.floor(sorted.length * 0.25)];
  const q75 = sorted[Math.floor(sorted.length * 0.75)];

  console.log('📊 전체 거래 데이터 통계');
  console.log(`  총 단지 수: ${allComplexes.length}`);
  console.log(`  총 거래 건수: ${total}`);
  console.log(`  평균: ${avg.toFixed(2)}건/단지`);
  console.log(`  중앙값: ${median}건`);
  console.log(`  Q1 (25%): ${q25}건`);
  console.log(`  Q3 (75%): ${q75}건`);
  console.log(`  최소: ${Math.min(...tradeCounts)}건`);
  console.log(`  최대: ${Math.max(...tradeCounts)}건`);

  // 2. 임계값별 단지 수
  console.log('\n📈 임계값별 단지 수');
  const thresholds = [10, 20, 32, 64, 100, 200];
  for (const threshold of thresholds) {
    const count = tradeCounts.filter((c) => c >= threshold).length;
    const pct = ((count / tradeCounts.length) * 100).toFixed(1);
    console.log(`  ${threshold}건 이상: ${count}개 (${pct}%)`);
  }

  // 3. 학습 가능성 확인 (기본값: WINDOW=24, HORIZON=36)
  console.log('\n🎯 학습 가능성 검증 (WINDOW=24, HORIZON=36)');
  const requiredTrades = 24 + 36 + 4; // 64
  const trainableCount = tradeCounts.filter((c) => c >= requiredTrades).length;
  console.log(`  필요 거래 건수: ${requiredTrades}건 이상`);
  console.log(`  학습 가능 단지: ${trainableCount}개 (${((trainableCount / tradeCounts.length) * 100).toFixed(1)}%)`);

  // 4. 상위 10개 단지 상세 정보
  console.log('\n🏆 거래 건수 상위 10개 단지');
  for (let i = 0; i < Math.min(10, allComplexes.length); i++) {
    const c = allComplexes[i];
    const cnt = Number(c.cnt);
    const trainable = cnt >= requiredTrades ? '✅ 학습 가능' : '❌ 데이터 부족';
    console.log(`  ${i + 1}. ${c.name.padEnd(30)} ${String(cnt).padStart(3)}건 ${trainable}`);
  }

  // 5. 거래 분포 히스토그램
  console.log('\n📊 거래 건수 분포 (히스토그램)');
  const buckets = [
    { min: 0, max: 10 },
    { min: 10, max: 20 },
    { min: 20, max: 30 },
    { min: 30, max: 50 },
    { min: 50, max: 64 },
    { min: 64, max: 100 },
    { min: 100, max: 200 },
    { min: 200, max: Infinity },
  ];

  for (const bucket of buckets) {
    const count = tradeCounts.filter((c) => c >= bucket.min && c < bucket.max).length;
    const barLength = Math.ceil(count / 10);
    const bar = '█'.repeat(barLength);
    const label = bucket.max === Infinity ? `${bucket.min}+` : `${bucket.min}-${bucket.max - 1}`;
    console.log(`  ${label.padStart(10)}: ${bar} ${count}개`);
  }

  // 6. 파라미터별 시뮬레이션
  console.log('\n🔧 파라미터 조정 시뮬레이션');
  const scenarios = [
    { window: 24, horizon: 36, name: '기본값' },
    { window: 12, horizon: 24, name: '1/2 축소' },
    { window: 12, horizon: 12, name: '더 강한 축소' },
    { window: 6, horizon: 12, name: '최소 수준' },
  ];

  for (const scenario of scenarios) {
    const required = scenario.window + scenario.horizon + 4;
    const trainable = tradeCounts.filter((c) => c >= required).length;
    const pct = ((trainable / tradeCounts.length) * 100).toFixed(1);
    console.log(`  [${scenario.name}] W=${scenario.window} H=${scenario.horizon} → ${required}건 필요 → ${trainable}개 (${pct}%)`);
  }

  // 7. 샘플 단지 상세 조회 (64건 이상 중 1개)
  if (trainableCount > 0) {
    const sampleId = allComplexes.find((c) => Number(c.cnt) >= requiredTrades)?.id;
    if (sampleId) {
      console.log(`\n🔍 학습 가능 단지 샘플 분석 (id=${sampleId})`);

      const trades = await prisma.aptTrade.findMany({
        where: { complexId: sampleId },
        orderBy: { dealDate: 'asc' },
        select: {
          dealDate: true,
          priceManwon: true,
          areaM2: true,
          floor: true,
        },
      });

      console.log(`  단지: ${allComplexes.find((c) => c.id === sampleId)?.name}`);
      console.log(`  총 거래: ${trades.length}건`);
      console.log(`  기간: ${trades[0]?.dealDate.toISOString().split('T')[0]} ~ ${trades[trades.length - 1]?.dealDate.toISOString().split('T')[0]}`);
      console.log(`  평형: ${Math.min(...trades.map((t) => t.areaM2)).toFixed(1)}㎡ ~ ${Math.max(...trades.map((t) => t.areaM2)).toFixed(1)}㎡`);
      console.log(`  가격: ${(Math.min(...trades.map((t) => t.priceManwon)) / 10000).toFixed(1)}억 ~ ${(Math.max(...trades.map((t) => t.priceManwon)) / 10000).toFixed(1)}억`);

      // 거래 월별 분포
      const monthlyCount = new Map<string, number>();
      trades.forEach((t) => {
        const month = t.dealDate.toISOString().substring(0, 7); // YYYY-MM
        monthlyCount.set(month, (monthlyCount.get(month) ?? 0) + 1);
      });
      console.log(`  월별 거래 분포:`);
      const firstMonth = trades[0].dealDate;
      const lastMonth = trades[trades.length - 1].dealDate;
      const monthSpan = (lastMonth.getFullYear() - firstMonth.getFullYear()) * 12 + (lastMonth.getMonth() - firstMonth.getMonth());
      console.log(`    기간: ${monthSpan}개월, 월평균 거래: ${(trades.length / (monthSpan + 1)).toFixed(2)}건`);
    }
  }

  await prisma.$disconnect();
}

analyzeTradeDistribution().catch((e) => {
  console.error('분석 중 오류:', e);
  process.exit(1);
});
