# 2026_MOLIT_ML

스마트 직세권 — **LSTM 가격 예측 학습 파이프라인** (로컬 전용).

같은 MySQL DB (`molit_contest`) 를 보고, 거래 시계열을 학습해 **t_training_result** 에 결과를 저장합니다. `2026_MOLIT_CONTEST` (Vercel/Render 배포) 와 분리된 별도 레포 — 클라우드 무료 호스팅의 메모리/CPU 한계를 회피하기 위해 학습은 로컬 PC 에서 무한 루프로 수행합니다.

## 구조

```
src/
├── db.ts                          # PrismaClient 싱글톤
├── train.ts                       # entry point (npm run train)
├── data/
│   ├── fetch.ts                   # 단지/구간별 거래 시계열 조회
│   └── preprocess.ts              # m²당 단가, 월별 집계, IQR 이상치 제거
├── models/
│   └── lstm.ts                    # LSTM 모델 정의/학습/예측
└── repository/
    └── trainingResultRepository.ts  # t_training_result upsert
prisma/
└── schema.prisma                  # DB 스키마 (server 와 같은 DB, TrainingResult 신규)
```

## 셋업 (1회)

```bash
# 1) 의존성 설치 — TensorFlow.js native 빌드 포함 (Windows 5~10분)
npm install

# 2) .env 작성
copy .env.example .env
notepad .env
#   DATABASE_URL 을 server/.env 와 동일하게

# 3) t_training_result 테이블만 신규 생성
#    기존 t_apt_complex / t_apt_trade / t_apt_rent 는 server 가 owner — 영향 없음
npm run prisma:push
```

⚠️ **TensorFlow.js native 빌드 실패 시 (Windows)** — `@tensorflow/tfjs-node` 가 Python/Visual Studio Build Tools 필요. 빌드가 깨지면 `package.json` 의 `@tensorflow/tfjs-node` 를 **`@tensorflow/tfjs`** 로 바꾸세요 (pure JS, 학습 5~10배 느림). 그리고 `src/models/lstm.ts` 의 `import * as tf from '@tensorflow/tfjs-node'` 를 `import * as tf from '@tensorflow/tfjs'` 로.

## 학습 실행

```bash
# 한 번만 순회 (테스트용)
npm run train:one

# 무한 루프 — 한 바퀴 끝나면 30분 쉬고 다시
npm run train
```

학습 환경변수 (모두 선택):

| 변수 | 기본 | 설명 |
|---|---|---|
| `MIN_SAMPLES_PER_BUCKET` | 20 | 학습 대상 단지의 최소 거래 건수 |
| `WINDOW_SIZE` | 24 | LSTM 입력 윈도우 (개월) |
| `HORIZON_MONTHS` | 36 | 예측 시점 (개월) |
| `MODEL_VERSION` | lstm-v1 | upsert 키의 일부, 모델 비교용 |
| `LIMIT` | 0 (없음) | 한 pass 에서 학습할 단지 수 제한 |

## 데이터 흐름

```
t_apt_trade (server ingest)
        │
        ▼
fetch.ts (단지 선별 + 거래 시계열)
        │
        ▼
preprocess.ts (m²당 단가, 월별 중위값, IQR, forward-fill)
        │
        ▼
LSTM.train (TensorFlow.js, MSE)
        │
        ▼
predictNext (3년 후 m²당 단가)
        │
        ▼
t_training_result (upsert)
```

## 운영 메모

- 학습 결과는 **DB 영구 저장** — 서버 재시작과 무관
- 같은 단지/구간/`MODEL_VERSION` 은 upsert 로 최신값으로 갱신
- `MODEL_VERSION` 을 `lstm-v2` 로 바꾸면 별개 시리즈로 누적 (A/B 비교)
- 한 단지 학습 평균 5~15초 → 1,000 단지면 1~4시간

## server 와 연결 (향후)

server (`2026_MOLIT_CONTEST`) 가 `t_training_result` 를 클라이언트로 보여주려면 server 쪽 schema 에도 동일 모델 추가가 필요합니다 (`prisma db pull` 또는 모델 수동 추가 후 `prisma generate`).
