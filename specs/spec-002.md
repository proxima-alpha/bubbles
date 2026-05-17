# Spec 002 — RAG 파이프라인

## 목표

메시지 임베딩 → 클러스터링 → knowledge/main memory 생성 → 컨텍스트 주입까지 RAG 파이프라인 전체를 구현한다.

---

## 태스크

- [ ] (1) DB 마이그레이션: memory 스코어 컬럼 + embedding 추가
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
  score               Float  @default(0)
  sensitivity         Float  @default(0)
  importance          Float  @default(0)
  durability          Float  @default(0)
  reusefulness        Float  @default(0)
  explicit_signal     Float  @default(0)
  repetition_count    Int    @default(0)
  user_action_score   Float  @default(0)
  llm_confidence_hint Float  @default(0)
  confirmed_score     Float  @default(0)
}
```

> **score 산정 공식** (plan.md 기준):
> `0.25*importance + 0.25*durability + 0.20*reusefulness + 0.20*confirmed + 0.10*recency - 0.30*sensitivity_penalty - 0.30*temporary_penalty`
>
> confirmed = `0.4*explicit_signal + 0.3*repetition_score + 0.2*user_action_score + 0.1*llm_confidence_hint`

마이그레이션: `npx prisma migrate dev --name add-memory-scoring`

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
this.embedAndSaveBackground(assistantMsg.id, fullContent);
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

매 1분마다 폴링. 아래 조건 중 하나 충족 시 배치 실행:

```typescript
@Cron('* * * * *') // 1분마다
async checkAndRun(userId: string) {
  const threshold = this.config.get<number>('SCHEDULER_MESSAGE_THRESHOLD', 5);
  const unproceeded = await this.prisma.message.count({
    where: { user_id: userId, is_proceeded: false, embedding: { not: null } },
  });
  const dayPassed = Date.now() - this.lastRunAt > 86_400_000;

  if (unproceeded >= threshold || dayPassed) {
    await this.runBatch(userId);
    this.lastRunAt = Date.now();
  }
}

private lastRunAt = 0; // 재시작 시 리셋 허용 (개인 프로젝트)
```

> 스케줄러는 user별로 실행하지 않고, 전체 미처리 messages 기준으로 판단 후 user별로 분리 처리.

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

    clusterer = hdbscan.HDBSCAN(min_cluster_size=2, metric='euclidean')
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
  "llm_confidence_hint": 0.0~1.0
}
```

---

## 6. Main Memory 재생성

### 승격 조건

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
  include: { contents: true },
});
```

### LLM 프롬프트 (main memory 재생성)

```
다음은 사용자에 대해 알려진 정보입니다.

[기존 기억]
{current_main_memory_content}

[새로 추가된 지식]
{promoted_knowledge_contents}

위 내용을 통합하여 사용자를 잘 아는 AI가 기억해야 할 핵심 정보를 압축하여 작성하세요.
```

### DB 처리

- 기존 main memory: `is_active = false`, `deactivated_at = now()`
- 새 memory: `type = 'main'`, `history_type = 'renewed'`, `version = 기존+1`
  - `root_memory_id`: 최초 main memory의 id (없으면 자기 자신)
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
  topKnowledge.map(m => m.content),
);
```

### memoryService.getTopKnowledge

pgvector cosine distance 사용:

```typescript
async getTopKnowledge(userId: string, embedding: number[], topK: number) {
  return this.prisma.$queryRaw`
    SELECT mc.content
    FROM memory m
    JOIN memory_content mc ON mc.memory_id = m.id
    WHERE m.user_id = ${userId}::uuid
      AND m.type = 'knowledge'
      AND m.is_active = true
      AND m.embedding IS NOT NULL
    ORDER BY m.embedding <=> ${embedding}::vector
    LIMIT ${topK}
  `;
}
```

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
  "score": 0.75,
  "version": 1,
  "isPinned": false,
  "createdAt": "2024-01-01T00:00:00Z"
}]
```

### Frontend — `/memory` 페이지

- 카드 목록: 키워드 배지 + score + 날짜
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
