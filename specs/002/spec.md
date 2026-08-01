# Spec 002 — RAG 파이프라인

## 목표

메시지 임베딩 → 클러스터링 → knowledge/main memory 생성 → 컨텍스트 주입까지 RAG 파이프라인 전체를 구현한다.

---

## 태스크

- [x] (1) DB 마이그레이션: memory 점수 컴포넌트 컬럼 + score + embedding 추가, message 토큰 사용량 컬럼 추가
- [x] (2) Ollama 임베딩 연동 (message 저장 시 embedding 생성, 실패 시 재시도 후 에러 반환)
- [x] (3) 스케줄러 기반 구조 + 트리거 조건
- [x] (4) clustering FastAPI 서버 구현 (AgglomerativeClustering, similarity threshold 기반)
- [x] (5) 클러스터 → knowledge memory 생성/merge + LLM 키워드/점수 산정
- [x] (6) 승격 조건 knowledge memories → main memory 재생성
- [x] (7) 컨텍스트 조립: 시스템 프롬프트 + RAG + 최근 messages
- [x] (8) knowledge memory 목록 API + UI

---

## 결정 사항

| # | 항목 | 결정 |
|---|------|------|
| A | 스케줄러 트리거 N | .env `SCHEDULER_MESSAGE_THRESHOLD=5` |
| B | Top N knowledge memories (RAG) | .env `RAG_TOP_K=5` |
| C | clustering 아키텍처 | FastAPI HTTP 서버, `apps/clustering/` 소스 유지, Docker build 시 복사 |
| D | embedding 실패 시 | 3회 재시도, 모두 실패 시 503 "잠시 후 재시도해주세요" |

---

## 1. DB 마이그레이션

### memory 테이블 변경

`keywords varchar[]` 컬럼 제거 (keyword 테이블로 대체):
```sql
ALTER TABLE memory DROP COLUMN keywords;
```

추가 컬럼:
```prisma
model memory {
  // 기존 컬럼 유지 (keywords 제거) ...

  // Spec 2 추가
  embedding           Unsupported("vector(768)")?
  score               Float     @default(0)      // 배치 시 계산하여 저장
  scored_at           DateTime? @db.Timestamptz  // score가 계산된 시각
  sensitivity         Float  @default(0)
  importance          Float  @default(0)
  durability          Float  @default(0)
  reusefulness        Float  @default(0)
  explicit_signal     Float  @default(0)
  repetition_strength Float  @default(0)  // 반복 강도 (0~1, 감쇠 + 유사도 누적)
  user_action_score   Float  @default(0)
  llm_confidence_hint Float  @default(0)
  confirmed_score     Float  @default(0)
  temporary_penalty   Float     @default(0)   // LLM 산정: 장기 기억 가치가 낮을수록 높음
  content             String?   @db.Text      // memory_content 원문 합산 텍스트 (클러스터링 유사도 비교용)
  summary             String?   @db.Text      // LLM 생성 요약 (RAG 컨텍스트 주입용)
  last_referenced_at  DateTime? @db.Timestamptz  // 마지막 RAG 조회 시각
  reference_count     Int       @default(0)   // RAG 조회 누적 횟수
}
```

### message 테이블 추가 컬럼

```prisma
model message {
  // 기존 컬럼 유지 ...

  // Spec 2 추가 — Ollama 응답 마지막 청크의 usage 필드에서 추출
  input_tokens      Int?
  output_tokens     Int?

  // Spec 2 추가 — assistant 메시지가 어떤 user 질문에 대한 응답인지 참조
  parent_message_id String?  @db.Uuid
  parent_message    message? @relation("message_parent", fields: [parent_message_id], references: [id])
  child_messages    message[] @relation("message_parent")
}
```

`parent_message_id`: assistant role 메시지에만 설정. user 질문 → assistant 응답 쌍을 DB 레벨에서 추적.

Ollama 스트리밍 응답의 마지막 청크(`data.done === true`)에 `prompt_eval_count`(입력), `eval_count`(출력) 필드가 포함됨. `ollama.provider.ts`에서 추출해 `ChatService`로 반환.

> **score 산정 공식** (plan.md 기준) — 배치 시 계산하여 `score` + `scored_at` DB 저장:
> `0.25*importance + 0.25*durability + 0.20*reusefulness + 0.20*confirmed_score + 0.10*recency - 0.30*sensitivity - 0.30*temporary_penalty`
>
> confirmed_score = `0.4*explicit_signal + 0.3*repetition_strength + 0.2*user_action_score + 0.1*llm_confidence_hint`
> repetition_strength: 이미 [0,1] 범위 — 직접 사용
>
> recency는 배치 실행 시점의 `last_referenced_at` 기준으로 계산 (당시 값으로 고정):
> ```
> days = (scored_at 시점의 now - last_referenced_at) in days   // null이면 created_at 사용
> recency = exp(-days / RECENCY_DECAY_FACTOR)  // .env: RECENCY_DECAY_FACTOR=30
> ```
>
> **clamp 규칙**: 모든 컴포넌트 값(LLM 반환값 및 계산값)은 사용 전 `[0.0, 1.0]`으로 clamp.
> 최종 score도 `clamp(계산값, 0.0, 1.0)` 적용 후 저장.
> 계산된 score와 scored_at을 함께 저장. score는 승격 조건·정렬에 사용.

### keyword + memory__keyword 테이블 신규 생성

```prisma
model keyword {
  code        String   @id @db.VarChar
  name        String   @db.VarChar
  description String?  @db.Text
  created_at  DateTime @default(now()) @db.Timestamptz

  memory__keyword memory__keyword[]
}

model memory__keyword {
  memory_id    String @db.Uuid
  keyword_code String @db.VarChar

  memory  memory  @relation(fields: [memory_id], references: [id])
  keyword keyword @relation(fields: [keyword_code], references: [code])

  @@id([memory_id, keyword_code])
}
```

### schedule 테이블 신규 생성

유저별 스케줄 실행 내역. 여러 스케줄 타입을 공통으로 관리.
`updated_at`이 마지막 실행 시각 역할을 겸함.

```prisma
model schedule {
  id            String   @id @default(uuid()) @db.Uuid
  user_id       String   @db.Uuid
  type_category String   @default("schedule_type") @db.VarChar
  type          String   @db.VarChar
  created_at    DateTime @default(now()) @db.Timestamptz
  updated_at    DateTime @default(now()) @db.Timestamptz  // DB trigger로 자동 갱신

  @@unique([user_id, type])

  user user @relation(...)
}
```

`updated_at` 자동 갱신은 Prisma `@updatedAt` 대신 DB trigger 사용. 모든 테이블의 `updated_at`에 동일하게 적용:

```sql
-- 마이그레이션 SQL에 포함 (schedule 테이블 예시, 다른 테이블도 동일 패턴)
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER schedule_updated_at
BEFORE UPDATE ON schedule
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

### 시드 추가

```typescript
// common_code_category
{ code: 'schedule_type', name: '스케줄 유형', order: 6 }

// common_code
{ category_code: 'schedule_type', code: 'memory_batch', name: '메모리 배치', order: 1 }
```

마이그레이션 (memory + message + schedule 변경을 하나로 합침):
```bash
npx prisma migrate dev --name spec002-rag-pipeline
```

---

## 2. Ollama 임베딩 연동

### OllamaProvider 확장

```typescript
// ollama.provider.ts
async embed(baseUrl: string, text: string): Promise<number[]> {
  const res = await fetch(`${baseUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
  });
  if (!res.ok) throw new Error(`Ollama embed error: ${res.status}`);
  const data = await res.json();
  return data.embedding; // number[] 768차원
}
```

### ModelService 확장

재시도 로직 포함 (최대 3회, 500ms 간격):

```typescript
async embedText(text: string): Promise<number[]> {
  const baseUrl = this.config.get('OLLAMA_BASE_URL', 'http://localhost:11434');
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await this.ollamaProvider.embed(baseUrl, text);
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise(r => setTimeout(r, 500));
    }
  }
}
```

### ChatService 수정

user message 임베딩은 RAG에 필요하므로 **동기 처리** — 실패 시 503 반환:

```typescript
// user message 저장
const userMsg = await this.prisma.message.create({ data: { ... } });

// 임베딩 — 실패 시 503
let queryEmbedding: number[];
try {
  queryEmbedding = await this.modelService.embedText(dto.content);
  await this.prisma.$executeRaw`
    UPDATE message SET embedding = ${queryEmbedding}::vector WHERE id = ${userMsg.id}::uuid
  `;
} catch (e) {
  res.status(503).json({ message: '잠시 후 재시도해주세요.' });
  return;
}

// assistant message 임베딩은 스트림 완료 후 background (실패해도 503 아님)
// fire-and-forget: 실패 시 콘솔 로그만 남기고 재시도 없음
void this.modelService.embedText(fullContent)
  .then(vec => this.prisma.$executeRaw`
    UPDATE message SET embedding = ${vec}::vector WHERE id = ${assistantMsg.id}::uuid
  `)
  .catch(e => console.error('assistant embed failed', e));
```

> **TODO**: assistant message 임베딩 실패 시 해당 메시지는 스케줄러에서 영구 제외됨 (`embedding IS NULL` 조건). 추후 실패 메시지 분류/재처리 메커니즘 필요 — 예: `message.embedding_failed_at` 컬럼 추가 후 실패 시 기록, 별도 재시도 배치에서 처리.

---

## 3. 스케줄러 구조

### 환경변수 (.env + .env.example 추가)

```bash
# Scheduler
SCHEDULER_MESSAGE_THRESHOLD=5       # 미처리 메시지가 이 수 이상이면 배치 실행
SCHEDULER_BATCH_INTERVAL_HOURS=24   # 마지막 배치 후 이 시간 이상 경과하면 재실행

# RAG
RAG_TOP_K=5                         # 컨텍스트에 주입할 knowledge memory 수
RECENCY_DECAY_FACTOR=30             # recency 감쇠 계수 (일 단위)

# Clustering
CLUSTERING_URL=http://clustering:8000
CLUSTERING_MIN_CLUSTER_SIZE=2       # 최소 클러스터 크기 (미달 시 noise 처리)
CLUSTERING_SIMILARITY_THRESHOLD=0.95 # 이 값 이상이면 같은 클러스터로 묶음
MAX_CLUSTER_SIZE=50                 # cluster_size_score 정규화 기준값

# Memory merge 조건
MERGE_MAX_SIMILARITY=0.8            # 기존 memory와 centroid 간 최대 similarity 임계값
MERGE_AVG_SIMILARITY=0.7            # 클러스터 내부 평균 similarity 임계값
REPETITION_SIMILARITY_THRESHOLD=0.6 # repetition_strength 갱신 대상 최소 similarity

# Memory 승격 조건
PROMOTION_SCORE_THRESHOLD=0.75       # main memory 승격 score 임계값
PROMOTION_SENSITIVITY_THRESHOLD=0.3 # main memory 승격 sensitivity 임계값
```

### 패키지 추가

```bash
npm install @nestjs/schedule
```

### MemoryModule 신규 생성

```
src/memory/
├── memory.module.ts
├── memory.service.ts     # knowledge/main memory CRUD + RAG 조회
├── scheduler.service.ts  # 트리거 체크 + 배치 오케스트레이션
├── decay.scheduler.ts    # 매일 00:00 UTC repetition_strength 감쇠
└── dto/
```

`decay.scheduler.ts`: 매일 00:00 UTC, 전체 active knowledge memories에 decay 적용:
```typescript
@Cron('0 0 * * *')
async applyDecay() {
  await this.prisma.$executeRaw`
    UPDATE memory
    SET repetition_strength = GREATEST(0, LEAST(1, repetition_strength * 0.995))
    WHERE type = 'knowledge' AND is_active = true
  `;
}
```

`AppModule`에 `ScheduleModule.forRoot()` + `MemoryModule` 추가.

### 트리거 조건

매 1분마다 폴링. 두 조건을 독립적으로 판단하여 대상 유저 목록 합산:

```typescript
@Cron('* * * * *')
async checkAndRun() {
  const threshold = this.config.get<number>('SCHEDULER_MESSAGE_THRESHOLD', 5);
  const intervalHours = this.config.get<number>('SCHEDULER_BATCH_INTERVAL_HOURS', 24);

  // 조건 1: 미처리 messages >= N인 유저
  const usersOverThreshold = await this.prisma.$queryRaw<{ user_id: string }[]>`
    SELECT user_id FROM message
    WHERE is_proceeded = false AND embedding IS NOT NULL
    GROUP BY user_id
    HAVING COUNT(*) >= ${threshold}
  `;

  // 조건 2: 마지막 배치 후 1일 경과한 유저 (schedule 기록 없는 유저 포함)
  //          단, 미처리 메시지(embedding 있음)가 1개 이상인 유저만 대상
  const usersOverDay = await this.prisma.$queryRaw<{ user_id: string }[]>`
    SELECT u.id AS user_id FROM "user" u
    LEFT JOIN schedule s ON s.user_id = u.id AND s.type = 'memory_batch'
    WHERE (s.id IS NULL OR s.updated_at < NOW() - (${intervalHours} || ' hours')::interval)
      AND EXISTS (
        SELECT 1 FROM message m
        WHERE m.user_id = u.id AND m.is_proceeded = false AND m.embedding IS NOT NULL
      )
  `;

  const targetIds = [...new Set([
    ...usersOverThreshold.map(u => u.user_id),
    ...usersOverDay.map(u => u.user_id),
  ])];

  for (const user_id of targetIds) {
    const batchResults = await this.runBatch(user_id);
    // batchResults: 이번 배치에서 생성/merge된 knowledge memory 목록
    // type: { id: string; is_pinned: boolean; score: number; sensitivity: number }[]
    await this.updateMainMemory(user_id, batchResults);
    await this.prisma.schedule.upsert({
      where: { user_id_type: { user_id, type: 'memory_batch' } },
      update: { updated_at: new Date() },  // UPDATE를 강제해야 DB trigger가 발동
      create: { user_id, type: 'memory_batch' },
    });
  }
}
```

---

## 4. Clustering FastAPI 서버

### 아키텍처

- `apps/clustering/` — FastAPI 앱 소스 (로컬/Docker 동일)
- Docker build: 현재 Dockerfile 구조 그대로, CMD만 uvicorn으로 변경
- 로컬 실행: `cd apps/clustering && uvicorn main:app --port 8000`
- NestJS → `POST http://clustering:8000/cluster` HTTP 호출

### apps/clustering/main.py

```python
from fastapi import FastAPI
from pydantic import BaseModel
import numpy as np
from sklearn.cluster import AgglomerativeClustering
from collections import Counter

app = FastAPI()

class ClusterRequest(BaseModel):
    vectors: list[list[float]]
    ids: list[str]
    min_cluster_size: int
    similarity_threshold: float

@app.post("/cluster")
def cluster(req: ClusterRequest):
    vectors = np.array(req.vectors)
    ids = req.ids

    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    normed = vectors / np.where(norms == 0, 1, norms)
    sim_matrix = normed @ normed.T
    distance_matrix = np.clip(1 - sim_matrix, 0, 2)

    distance_threshold = 1 - req.similarity_threshold
    model = AgglomerativeClustering(
        n_clusters=None, metric='precomputed',
        linkage='single', distance_threshold=distance_threshold,
    )
    labels = model.fit_predict(distance_matrix)

    label_counts = Counter(labels)
    clusters: dict[int, list[str]] = {}
    noise: list[str] = []
    for idx, label in enumerate(labels):
        if label_counts[label] < req.min_cluster_size:
            noise.append(ids[idx])
        else:
            clusters.setdefault(int(label), []).append(ids[idx])

    return {
        "clusters": [{"label": k, "ids": v} for k, v in clusters.items()],
        "noise": noise,
    }
```

- `linkage='single'`: 두 exchange 중 하나라도 similarity >= threshold면 같은 클러스터로 묶음
- noise: `min_cluster_size` 미달 클러스터 → 즉시 단일 exchange로 처리 후 `is_proceeded = true`

### apps/clustering/requirements.txt

```
fastapi
uvicorn[standard]
numpy
scikit-learn
```

### apps/clustering/Dockerfile (CMD 수정)

```dockerfile
FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gcc g++ && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### docker-compose.yml 변경

```yaml
clustering:
  build:
    context: ./apps/clustering
  ports:
    - "8000:8000"    # 로컬 디버그용
```

### NestJS → clustering HTTP 호출

```typescript
// scheduler.service.ts
private async runClustering(vectors: number[][], ids: string[]) {
  const url = this.config.get('CLUSTERING_URL', 'http://clustering:8000');
  const minClusterSize = this.config.get<number>('CLUSTERING_MIN_CLUSTER_SIZE', 2);
  const similarityThreshold = this.config.get<number>('CLUSTERING_SIMILARITY_THRESHOLD', 0.95);
  const res = await fetch(`${url}/cluster`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vectors, ids, min_cluster_size: minClusterSize, similarity_threshold: similarityThreshold }),
  });
  if (!res.ok) throw new Error(`Clustering error: ${res.status}`);
  return res.json();
}
```

---

## 5. 클러스터 → Knowledge Memory 생성/Merge

### Exchange 페어링

클러스터링 전에 미처리 messages를 exchange 단위로 묶는다:
- **assistant 메시지 기준 (1st pass)**: `parent_message_id`로 연결된 user 메시지와 페어링 → 1 exchange (centroid embedding 사용)
- **standalone (2nd pass)**: 페어링 안 된 메시지는 단독 exchange

exchange는 클러스터링의 단위 벡터로 사용됨.

### 로직 흐름

`runBatch(userId)`는 아래를 수행하고 생성/merge된 memory 목록을 반환한다:
`Promise<{ id: string; is_pinned: boolean; score: number; sensitivity: number }[]>`

```
각 클러스터에 대해:
  1. 클러스터 centroid 계산 (클러스터 내 message embeddings 평균)
  2. 기존 knowledge memories embedding과 cosine similarity 계산
     (pgvector: 1 - (embedding <=> centroid::vector))
  3. max_similarity >= MERGE_MAX_SIMILARITY (default 0.8)
     AND 클러스터 내부 avg_similarity >= MERGE_AVG_SIMILARITY (default 0.7)
         (= 클러스터 내 각 message embedding과 centroid 간 cosine similarity 평균)
     → merge: 기존 memory is_active=false, deactivated_at=now()
              (기존 memory_contents + memory__keywords는 기존 row에 유지 — 이력 보존)
              신규 memory row 생성: type='knowledge', history_type='renewed',
                version=기존+1, parent_memory_id=기존 id,
                root_memory_id=기존 root_memory_id (null이면 기존 id)
              신규 memory_content: step 5 LLM 응답 contents로 생성 (재귀속 아님)
              embedding 재계산: 모든 연결 messages embeddings의 centroid
  4. 조건 미충족
     → 신규 knowledge memory + memory_content 생성
  5. LLM 호출 (클러스터 수만큼 병렬, user.model 사용): keywords + 점수 요소 산정
     입력: 신규 memory → 이번 배치 클러스터 messages 원문 / merge → 기존 memory.content + 이번 클러스터 messages 원문
  5a. LLM 반환 importance 보정:
      cluster_size_score = min(1, log(1 + cluster_size) / log(1 + MAX_CLUSTER_SIZE))
      importance = clamp(importance + 0.15 * cluster_size_score, 0, 1)
      (.env: MAX_CLUSTER_SIZE=50)
  6. score 계산 후 memory에 저장 (score, scored_at, confirmed_score 등 컴포넌트)
     + LLM 반환 keywords → keyword 테이블 upsert (ON CONFLICT (code) DO NOTHING — 기존 name 유지)
       + memory__keyword 연결 (ON CONFLICT DO NOTHING — 기존 링크 유지)
  7. LLM 응답의 attribution 맵으로 memory_content__message 생성
     (attribution 없는 contents 행은 저장 금지)
     memory.content = contents 배열을 \n으로 join하여 저장
     포함 messages: is_proceeded = true
  8. 노이즈(min_cluster_size 미달): 단일 exchange로 즉시 처리 → is_proceeded = true
     처리된 memory도 반환 목록에 포함
  9. repetition_strength 갱신: 이번 배치에서 is_proceeded = true된 messages의 embedding과
     이번 배치 이전부터 존재하던 knowledge memories (batchResults ids 제외) embedding 비교.
     similarity >= REPETITION_SIMILARITY_THRESHOLD인 memory마다:
       repetition_strength = clamp(repetition_strength + 0.005 * similarity, 0, 1)
반환: 클러스터 + 노이즈 경로로 생성/merge된 전체 memory rows (id, is_pinned, score, sensitivity)
```

### 단일 메시지 케이스 (미처리 exchange 수 < CLUSTERING_MIN_CLUSTER_SIZE)

clustering 서버 호출 없이 exchange 단위로 각각 처리:

```
1. 메시지 embedding과 기존 knowledge memories 간 cosine similarity 계산
2. max_similarity >= MERGE_MAX_SIMILARITY → merge (MERGE_AVG_SIMILARITY 조건 생략, 신규 row 생성 동일)
3. 미충족 → 신규 knowledge memory 생성
4. 이후 steps 5a–7 동일 (cluster_size = 1)
```

### memory_content 구조 설계

- `memory` = LLM이 생성한 요약 문단 전체
- `memory_content` = 그 문단을 구성하는 각 문장 (LLM이 배열로 반환)
- `memory_content__message` = 각 문장이 어떤 원본 메시지에서 유래했는지 (N:M 귀속)
  - **불변 조건**: `memory_content` 1행은 반드시 1개 이상의 message와 연결되어야 함 (근거 없는 문장 금지)
- `memory.content` = `memory_content` 문장들을 `\n`으로 join한 전체 텍스트

### LLM 입력 포맷

메시지 원문을 role/provider 구분 + `message_id` 포함 배열로 전달:

```json
// provider가 "user"이면 이용자 질문, 그 외는 AI 제공자명
[
  {"user":   {"text": "파이썬 list comprehension이 뭐야?", "message_id": "uuid-a"}},
  {"ollama": {"text": "[x*2 for x in lst] 이렇게 쓰면 돼", "message_id": "uuid-b"}}
]
```

merge 케이스: 기존 `memory.content` 문장들을 먼저 배열에 포함 (`message_id` 없음 — 이미 처리된 기존 내용).
associations 대상은 새 messages만.

### LLM 프롬프트 (키워드 + 점수 산정)

```
다음 대화 내용을 분석하여 JSON으로만 응답하세요.

{입력 배열 — [{provider_or_user: {text, message_id}}, ...]}

{
  "keywords": [{"code": "영문-소문자-하이픈-슬러그", "name": "표시할 한국어명"}],
  "contents": ["문장1", "문장2", "문장3"],
  "associations": [
    ["uuid-a", "uuid-b"],
    ["uuid-b"]
  ],
  "summary": "한 문장 요약",
  "importance": 0.0~1.0,
  "durability": 0.0~1.0,
  "reusefulness": 0.0~1.0,
  "sensitivity": 0.0~1.0,
  "explicit_signal": 0.0~1.0,
  "llm_confidence_hint": 0.0~1.0,
  "temporary_penalty": 0.0~1.0
}

// contents: memory_content 문장 배열
// associations: contents와 같은 길이의 배열. association[i] = contents[i]의 근거 message_id 목록
// temporary_penalty: 이 정보가 장기 기억으로 남길 가치가 낮을수록 높게 부여
// (예: 오늘 날씨, 일시적 감정 → 높음 / 직업, 가치관 → 낮음)
```

`associations` 처리:
- `contents[i]`와 `associations[i]`는 같은 index로 대응
- user 메시지는 LLM 입력 컨텍스트용으로만 포함 — `associations`에서 user message_id는 제외
- `associations[i]`가 비어있거나 없는 `contents[i]`는 저장하지 않음 (근거 없는 문장 금지)
- `associations[i]`의 message_id → `memory_content__message` 생성

---

## 6. Main Memory 재생성

`runBatch()`가 반환한 `batchResults`를 `updateMainMemory(userId, batchResults)`로 전달.

### 트리거 조건

이번 배치(batchResults)에서 생성/merge된 knowledge memories 중 승격 조건을 만족하는 게 1개 이상일 때만 실행. 없으면 스킵.

```typescript
// batchResults: runBatch()의 반환값
// type: { id: string; is_pinned: boolean; score: number; sensitivity: number }[]
async updateMainMemory(userId: string, batchResults: { id: string; is_pinned: boolean; score: number; sensitivity: number }[]) {
  const scoreThreshold = this.config.get<number>('PROMOTION_SCORE_THRESHOLD', 0.9);
  const sensitivityThreshold = this.config.get<number>('PROMOTION_SENSITIVITY_THRESHOLD', 0.3);
  const newlyPromoted = batchResults.filter(m =>
    m.is_pinned || (m.score > scoreThreshold && m.sensitivity <= sensitivityThreshold)
  );
  if (newlyPromoted.length === 0) return;
```

### 승격된 memories 조회

트리거 통과 후, 전체 승격 조건 만족하는 knowledge memories를 LLM에 주입:

```typescript
const promoted = await this.prisma.memory.findMany({
  where: {
    user_id: userId,
    type: 'knowledge',
    is_active: true,
    OR: [
      { is_pinned: true },
      { AND: [{ score: { gt: scoreThreshold } }, { sensitivity: { lte: sensitivityThreshold } }] },
    ],
  },
});
```

### LLM 프롬프트 (main memory 재생성)

첫 생성 시 "[기존 기억]" 섹션 생략:
```
다음은 사용자에 대해 알려진 정보입니다.

[새로 추가된 지식]
{promoted.map(m => m.summary).join('\n---\n')}

위 내용을 바탕으로 사용자를 잘 아는 AI가 기억해야 할 핵심 정보를 압축하여 작성하세요.
```

갱신 시 기존 기억 포함:
```
다음은 사용자에 대해 알려진 정보입니다.

[기존 기억]
{getActiveMainMemory() 반환값 — memory.summary}

[새로 추가된 지식]
{promoted.map(m => m.summary).join('\n---\n')}

위 내용을 통합하여 사용자를 잘 아는 AI가 기억해야 할 핵심 정보를 압축하여 작성하세요.
```

### DB 처리

첫 생성 (기존 main memory 없음):
- 새 memory: `type = 'main'`, `history_type = 'renewed'`, `version = 1`
  - `root_memory_id`: null, `parent_memory_id`: null

갱신 (기존 main memory 있음):
- 기존 main memory: `is_active = false`, `deactivated_at = now()`
- 새 memory: `type = 'main'`, `history_type = 'renewed'`, `version = 기존+1`
  - `root_memory_id`: null (null이면 본인이 root로 처리)
  - `parent_memory_id`: 비활성화된 이전 main memory id

---

## 7. 컨텍스트 조립

### 시스템 프롬프트 빌더

```typescript
// chat.service.ts
function buildSystemPrompt(mainMemory: string | null, knowledgeItems: string[]): string {
  let prompt = '당신은 사용자를 깊이 이해하는 개인 AI 어시스턴트입니다.';
  if (mainMemory) prompt += `\n\n[사용자 기억]\n${mainMemory}`;
  if (knowledgeItems.length > 0) prompt += `\n\n[관련 지식]\n${knowledgeItems.join('\n---\n')}`;
  return prompt;
}
```

### chat.service.ts 컨텍스트 조립 수정

```typescript
// 이미 계산된 queryEmbedding 재사용 (task 2에서 생성)
const topK = this.config.get<number>('RAG_TOP_K', 5);
const mainMemory = await this.memoryService.getActiveMainMemory(userId);
const topKnowledge = await this.memoryService.getTopKnowledge(userId, queryEmbedding, topK);
const systemPrompt = buildSystemPrompt(
  mainMemory,
  topKnowledge.map(m => m.summary),
);
```

### memoryService.getTopKnowledge

`memory.summary`(LLM 요약)를 RAG 주입용으로 조회 — JOIN 없음:

```typescript
async getTopKnowledge(userId: string, embedding: number[], topK: number) {
  const rows = await this.prisma.$queryRaw<{ id: string; summary: string }[]>`
    SELECT id, summary
    FROM memory
    WHERE user_id = ${userId}::uuid
      AND type = 'knowledge'
      AND is_active = true
      AND embedding IS NOT NULL
      AND summary IS NOT NULL
    ORDER BY embedding <=> ${embedding}::vector
    LIMIT ${topK}
  `;

  if (rows.length > 0) {
    const ids = rows.map(r => r.id);
    await this.prisma.$executeRaw`
      UPDATE memory
      SET last_referenced_at = NOW(),
          reference_count = reference_count + 1
      WHERE id = ANY(${ids}::uuid[])
    `;
  }

  return rows;
}
```

> **sync 규칙**:
> - `memory.content` (knowledge only) = `memory_contents.orderBy(order).map(c => c.content).join('\n\n')` — 생성/merge 시 갱신. 클러스터링 유사도 비교에 사용.
> - `memory.summary` = LLM이 생성한 텍스트 — knowledge: 요약 문장, main: LLM 합성 전문. RAG 컨텍스트 주입에 사용.
> - `getActiveMainMemory(userId)`: `SELECT summary FROM memory WHERE user_id = ? AND type = 'main' AND is_active = true LIMIT 1` — `summary` 필드 반환

### OllamaProvider 시스템 프롬프트 지원

```typescript
// chatStream 호출 시 messages 앞에 system role 추가
const allMessages = systemPrompt
  ? [{ role: 'system' as const, content: systemPrompt }, ...messages]
  : messages;
```

---

## 8. Knowledge Memory 목록 API + UI

### MemoryController

```
GET /memory/knowledge   → KnowledgeMemory[]
```

응답 shape:
```json
[{
  "id": "uuid",
  "keywords": [{"code": "keyword-slug", "name": "키워드 표시명"}],
  "version": 1,
  "isPinned": false,
  "createdAt": "2024-01-01T00:00:00Z"
}]
```

### Frontend — `/memory` 페이지

- 카드 목록: 키워드 배지 + 날짜
- 삭제/편집은 Spec 3

