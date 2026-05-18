import { PrismaClient } from '@prisma/client';

/**
 * PrismaClient 싱글톤.
 *  - 학습 스크립트는 단일 프로세스로 길게 도므로 한 번만 생성.
 *  - tsx watch 대비 globalThis 캐싱 (개발 모드 안전망).
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
