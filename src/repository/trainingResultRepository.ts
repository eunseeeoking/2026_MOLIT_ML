import type { AreaBucket, AgeBucket, Prisma } from '@prisma/client';
import { prisma } from '../db';

export interface SaveTrainingResultInput {
  complexId: number | null;
  sigunguCode: string;
  legalDong: string;
  areaBucket: AreaBucket;
  ageBucket: AgeBucket;
  baseDate: Date;
  currentPricePerM2: number;
  predicted1yPricePerM2: number | null;
  predicted3yPricePerM2: number | null;
  expectedReturn3y: number | null;
  confidence: number | null;
  mae: number | null;
  mape: number | null;
  sampleCount: number;
  modelVersion: string;
  modelMeta?: Prisma.InputJsonValue;
}

/**
 * unique key (sigungu, dong, area, age, complex, base_date, model_version) 가 일치하면 update,
 * 아니면 create — `upsert` 패턴.
 *  - complexId 가 null 인 행도 같은 키 다른 base_date 면 별개로 저장
 */
export async function upsertTrainingResult(
  input: SaveTrainingResultInput,
): Promise<void> {
  await prisma.trainingResult.upsert({
    where: {
      sigunguCode_legalDong_areaBucket_ageBucket_complexId_baseDate_modelVersion: {
        sigunguCode: input.sigunguCode,
        legalDong: input.legalDong,
        areaBucket: input.areaBucket,
        ageBucket: input.ageBucket,
        complexId: input.complexId ?? 0, // null 은 unique 가 동작 안 하므로 0
        baseDate: input.baseDate,
        modelVersion: input.modelVersion,
      },
    },
    create: {
      ...input,
      complexId: input.complexId ?? null,
    },
    update: {
      currentPricePerM2: input.currentPricePerM2,
      predicted1yPricePerM2: input.predicted1yPricePerM2,
      predicted3yPricePerM2: input.predicted3yPricePerM2,
      expectedReturn3y: input.expectedReturn3y,
      confidence: input.confidence,
      mae: input.mae,
      mape: input.mape,
      sampleCount: input.sampleCount,
      modelMeta: input.modelMeta,
      trainedAt: new Date(),
    },
  });
}
