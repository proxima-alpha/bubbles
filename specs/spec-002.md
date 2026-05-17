# Spec 002 — RAG 파이프라인

## 목표

메시지 임베딩 → 클러스터링 → knowledge/main memory 생성 → 컨텍스트 주입까지 RAG 파이프라인 전체를 구현한다.

---

## 태스크

- [ ] (1) DB 마이그레이션: memory 스코어 컬럼 + embedding 추가, message 토큰 사용량 컬럼 추가
- [ ] (2) Ollama 임베딩 연동 (message 저장 시 embedding 생성, 실패 시 재시도 후 에러 반환)
- [ ] (3) 스케줄러 기반 구조 + 트리거 조건
- [ ] (4) clustering FastAPI 서버 구현 (HDBSCAN)
- [ ] (5) 클러스터 → knowledge memory 생성/merge + LLM 키워드/점수 산정
- [ ] (6) 승격 조건 knowledge memories → main memory 재생성
- [ ] (7) 컨텍스트 조립: 시스템 프롬프트 + RAG + 최근 messages
- [ ] (8) knowledge memory 목록 API + UI

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

### memory 테이블 추가 컬럼

```prisma
model memory {
  // 기존 컬럼 유지 ...

  // Spec 2 추가
  embedding           Unsupported("vector(768)")?
  sensitivity         Float  @default(0)
  importance          Float  @default(0)
  durability          Float  @default(0)
  reusefulness        Float  @default(0)
  explicit_signal     Float  @default(0)
  repetition_count    Int    @default(0)
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
  input_tokens  Int?
  output_tokens Int?
}
```

Ollama 스트리밍 응답의 마지막 청크(`data.done === true`)에 `prompt_eval_count`(입력), `eval_count`(출력) 필드가 포함됨. `ollama.provider.ts`에서 추출해 `ChatService`로 반환.

> **score 산정 공식** (plan.md 기준) — DB에 저장하지 않고 동적 계산:
> `0.25*importance + 0.25*durability + 0.20*reusefulness + 0.20*confirmed_score - 0.30*sensitivity - 0.30*temporary_penalty`
>
> confirmed_score = `0.4*explicit_signal + 0.3*repetition_score + 0.2*user_action_score + 0.1*llm_confidence_hint`
>
> recency (RAG 정렬 보정용, 저장하지 않음):
> ```
> days = (now - last_referenced_at) in days   // last_referenced_at이 null이면 created_at 사용
> recency = exp(-days / RECENCY_DECAY_FACTOR)  // .env: RECENCY_DECAY_FACTOR=30
> ```
> score는 배치 시 컴포넌트 값으로 앱 코드에서 계산. 승격 조건 판단 등에 사용하며 DB에 별도 컬럼으로 저장하지 않음.

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
} catch {
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

---

## 3. 스케줄러 구조

### 환경변수 (.env 추가)

```bash
# Scheduler: 미처리 메시지가 이 수 이상 쌓이면 배치 실행
SCHEDULER_MESSAGE_THRESHOLD=5

# RAG: 컨텍스트에 주입할 knowledge memory 수
RAG_TOP_K=5

# Clustering service URL
CLUSTERING_URL=http://clustering:8000

# Recency 감쇠 계수 (일 단위, 클수록 천천히 감쇠)
RECENCY_DECAY_FACTOR=30
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
└── dto/
```

`AppModule`에 `ScheduleModule.forRoot()` + `MemoryModule` 추가.

### 트리거 조건

매 1분마다 폴링. 두 조건을 독립적으로 판단하여 대상 유저 목록 합산:

```typescript
@Cron('* * * * *')
async checkAndRun() {
  const threshold = this.config.get<number>('SCHEDULER_MESSAGE_THRESHOLD', 5);

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
    WHERE (s.id IS NULL OR s.updated_at < NOW() - INTERVAL '1 day')
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

### apps/clustering/main.py (FastAPI로 교체)

```python
from fastapi import FastAPI
from pydantic import BaseModel
import numpy as np
import hdbscan

app = FastAPI()

class ClusterRequest(BaseModel):
    vectors: list[list[float]]
    ids: list[str]

@app.post("/cluster")
def cluster(req: ClusterRequest):
    vectors = np.array(req.vectors)
    ids = req.ids

    clusterer = hdbscan.HDBSCAN(min_cluster_size=2, metric='cosine')
    labels = clusterer.fit_predict(vectors)

    clusters: dict[int, list[str]] = {}
    noise: list[str] = []
    for idx, label in enumerate(labels):
        if label == -1:
            noise.append(ids[idx])
        else:
            clusters.setdefault(int(label), []).append(ids[idx])

    return {
        "clusters": [{"label": k, "ids": v} for k, v in clusters.items()],
        "noise": noise,
    }
```

### apps/clustering/requirements.txt (업데이트)

```
fastapi
uvicorn[standard]
hdbscan
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
  const res = await fetch(`${url}/cluster`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vectors, ids }),
  });
  if (!res.ok) throw new Error(`Clustering error: ${res.status}`);
  return res.json();
}
```

---

## 5. 클러스터 → Knowledge Memory 생성/Merge

### 로직 흐름

`runBatch(userId)`는 아래를 수행하고 생성/merge된 memory 목록을 반환한다.
score는 컴포넌트 값으로 앱 코드에서 계산하여 포함:
`Promise<{ id: string; is_pinned: boolean; score: number; sensitivity: number }[]>`
(score는 저장되지 않는 동적 계산값 — 승격 조건 판단 후 버려짐)

```
각 클러스터에 대해:
  1. 클러스터 centroid 계산 (벡터 평균)
  2. 기존 knowledge memories embedding과 cosine similarity 계산
     (pgvector: 1 - (embedding <=> centroid::vector))
  3. max_similarity >= 0.8 AND 클러스터 내부 avg_similarity >= 0.7
     → merge: 새 memory_content 추가, version+1, embedding 재계산
  4. 조건 미충족
     → 신규 knowledge memory + memory_content 생성
  5. LLM 호출 (클러스터 수만큼 병렬): keywords + 점수 요소 산정
  6. 포함 messages: is_proceeded = true, memory_content__message FK 연결
  7. 노이즈: is_proceeded = false 유지 (다음 배치에서 재처리)
반환: 위에서 생성/merge된 memory rows (id, is_pinned, score, sensitivity)
```

### LLM 프롬프트 (키워드 + 점수 산정)

```
다음 대화 내용을 분석하여 JSON으로만 응답하세요.

{messages_content}

{
  "keywords": ["키워드1", "키워드2"],
  "summary": "한 문장 요약",
  "importance": 0.0~1.0,
  "durability": 0.0~1.0,
  "reusefulness": 0.0~1.0,
  "sensitivity": 0.0~1.0,
  "explicit_signal": 0.0~1.0,
  "llm_confidence_hint": 0.0~1.0,
  "temporary_penalty": 0.0~1.0
}

// temporary_penalty: 이 정보가 장기 기억으로 남길 가치가 낮을수록 높게 부여
// (예: 오늘 날씨, 일시적 감정 → 높음 / 직업, 가치관 → 낮음)
```

---

## 6. Main Memory 재생성

`runBatch()`가 반환한 `batchResults`를 `updateMainMemory(userId, batchResults)`로 전달.

### 트리거 조건

이번 배치(batchResults)에서 생성/merge된 knowledge memories 중 승격 조건을 만족하는 게 1개 이상일 때만 실행. 없으면 스킵.

```typescript
// batchResults: runBatch()의 반환값 — score는 배치 시 동적 계산값 (DB 미저장)
// type: { id: string; is_pinned: boolean; score: number; sensitivity: number }[]
async updateMainMemory(userId: string, batchResults: { id: string; is_pinned: boolean; score: number; sensitivity: number }[]) {
  const newlyPromoted = batchResults.filter(m =>
    m.is_pinned || (m.score > 0.9 && m.sensitivity <= 0.3)
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
      { AND: [{ score: { gt: 0.9 } }, { sensitivity: { lte: 0.3 } }] },
    ],
  },
});
```

### LLM 프롬프트 (main memory 재생성)

```
다음은 사용자에 대해 알려진 정보입니다.

[기존 기억]
{current_main_memory_content}

[새로 추가된 지식]
{promoted.map(m => m.summary).join('\n---\n')}

위 내용을 통합하여 사용자를 잘 아는 AI가 기억해야 할 핵심 정보를 압축하여 작성하세요.
```

### DB 처리

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
  "keywords": ["키워드"],
  "version": 1,
  "isPinned": false,
  "createdAt": "2024-01-01T00:00:00Z"
}]
```

### Frontend — `/memory` 페이지

- 카드 목록: 키워드 배지 + 날짜
- 삭제/편집은 Spec 3

---

## .env.example 추가 항목

```bash
# Scheduler: 미처리 메시지가 이 수 이상 쌓이면 배치 실행
SCHEDULER_MESSAGE_THRESHOLD=5

# RAG: 컨텍스트에 주입할 knowledge memory 수
RAG_TOP_K=5

# Clustering FastAPI 서버 URL
CLUSTERING_URL=http://clustering:8000
```
