// @tensorflow/tfjs-layers 4.22.0 (transitively via @tensorflow/tfjs 4.20)
// 패키지가 npm 배포 시 .d.ts 파일을 단 1개도 포함하지 않은 채 출시됨.
// (확인: node_modules/@tensorflow/tfjs-layers/dist/ 에 *.d.ts 0개,
//  package.json "types": "dist/index.d.ts" 가 실제로는 누락)
//
// 결과:
//   · 메인 tfjs index.d.ts 의 `export * from '@tensorflow/tfjs-layers'` 가 무의미해짐
//     → `import * as tf from '@tensorflow/tfjs'` 후 tf.LayersModel/sequential/layers 못 찾음
//   · sub-package 직접 import 도 declaration 없음 에러 TS7016
//
// 처방:
//   본 ambient declaration 으로 `@tensorflow/tfjs-layers` 에 빈 타입을 부여 →
//   import 가 통과하고 모든 사용은 implicit `any`.
//   런타임은 정상 (4.x re-export 그대로 동작).
//
// 향후 tfjs 가 d.ts 를 정상 배포하면 본 파일 삭제 가능.

declare module '@tensorflow/tfjs-layers' {
  // lstm.ts 가 직접 사용하는 멤버만 명시 — 나머지는 any 로 통과.
  // (`declare module 'X';` 만 쓰면 named import 가 통과 안 함)
  export type LayersModel = any;
  export type Sequential = any;
  export const layers: any;
  export function sequential(...args: any[]): any;
  // 다른 사용처가 생기면 여기에 export const/function 추가
}
