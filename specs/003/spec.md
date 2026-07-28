# Spec 003 — 지식 관리 & 키워드

## 목표

knowledge memory를 유저가 직접 편집/고정/삭제할 수 있게 하고, main memory 조회/편집, 키워드 대시보드, md import/export, score 기반 망각(forgetting) 옵션을 구현한다.

---

## 태스크

- [ ] (1) DB 마이그레이션: `memory.deleted_at` 추가 (soft delete)
- [ ] (2) knowledge memory 삭제
- [ ] (3) knowledge memory pin 토글
- [ ] (4) knowledge memory 수동 편집 (새 버전 생성)
- [ ] (5) main memory 조회 + 수동 편집
- [ ] (6) 키워드 대시보드
- [ ] (7) md import / export
- [ ] (8) 망각 옵션 (score 기반 자동 정리)

---

## 결정 사항 (초안 — feedback 필요)

| # | 항목 | 제안 |
|---|------|------|
| A | 삭제 방식 | soft delete. `memory.deleted_at` 추가, 삭제 시 `deleted_at=now()` + 연결된 `memory_content`/`memory_content__message`/`memory__keyword` row는 실제 삭제(hard delete) — plan.md "relation은 제거" 문구 반영. `message` 원본은 손대지 않음 |
| B | 삭제된 memory의 근거였던 message 재처리 여부 | 재처리 안 함 — `message.is_proceeded=true`, `root_memory_id`만 NULL로 리셋. 다음 배치에서 다시 클러스터링 대상이 되지 않음 (유저가 "이 지식은 틀렸다/필요없다"고 삭제한 것이므로 자동 재생성 방지가 안전한 기본값이라 판단). 재생성 원하면 향후 별도 기능으로 |
| C | 수동 편집/import 시 문장별 message 근거 필요 여부 | **불필요** — Spec 2에서 정한 "근거 없는 문장 금지" 불변조건은 LLM 자동 생성(`created`/`renewed`)에만 적용. `history_type='modified'`(수동편집)/`uploaded`(import)는 유저 본인이 근거이므로 `memory_content__message` 연결 없이 저장 |
| D | 키워드 가중치 공식 | `weight = frequency + recency` (frequency: 해당 keyword가 걸린 active knowledge memory 수, recency: 가장 최근 `memory__keyword.created_at` 기준 `exp(-days/RECENCY_DECAY_FACTOR)`, 기존 .env 값 재사용) |
| E | import 시 점수/키워드 산정 | LLM 분석 재사용 — Spec 2 `callLlmForAnalysis`와 동일 프롬프트로 업로드된 원문을 분석해 keywords/점수/summary 산정 (import도 다른 knowledge memory와 동일하게 병합·RAG 대상이 되어야 하므로). 단, `contents`/`associations`는 문장 근거 매핑 없이 원문 전체를 `memory.content`로 그대로 저장 (C 항목과 연결) |
| F | export 포맷 | 단건: `GET /memory/knowledge/:id/export` → 해당 memory의 `content`를 `.md` 텍스트로 응답. 전체: `GET /memory/export` → 활성 knowledge memory 전체를 `---`로 구분해 하나의 `.md`로 응답 |
| G | 망각 옵션 on/off 단위 | 유저별 설정 UI는 Spec 4(설정 페이지) 범위라 이번엔 제외. 전역 `.env` 플래그(`FORGETTING_ENABLED`)로 on/off, 켜져 있으면 전체 유저 대상 매일 배치 실행 |
| H | pin 토글 시 점수 재계산 | 즉시 재계산 — `user_action_score`를 pin=true일 때 1.0, false일 때 0으로 갱신하고 `confirmed_score`/`score`도 그 자리에서 재계산해 저장 (다음 배치까지 기다리지 않음). Spec 2에서 `confirmed_score` 계산 시 `user_action_score`가 항상 0으로 하드코딩돼 있던 부분을 여기서 실제로 채움 |

---

## 1. DB 마이그레이션

```prisma
model memory {
  // 기존 컬럼 유지 ...
  deleted_at DateTime? @db.Timestamptz  // soft delete. NULL이면 미삭제
}
```

`message.root_memory_id`는 Spec 2에서 이미 FK/nullable이므로 컬럼 추가 없음 (Task 2에서 UPDATE로 NULL 리셋만 함).

```bash
npx prisma migrate dev --name spec003-memory-deleted-at
```

---

## 2. Knowledge Memory 삭제

`DELETE /memory/knowledge/:id` (컨트롤러 라우팅, thin) → `memoryService.deleteKnowledge(userId, id)`.

```typescript
// memory.repository.ts
async deleteKnowledgeMemory(userId: string, id: string) {
  const memory = await this.prisma.memory.findFirst({
    where: { id, user_id: userId, type: 'knowledge', deleted_at: null },
  });
  if (!memory) return null;

  await this.prisma.$transaction(async (tx) => {
    await tx.message.updateMany({
      where: { root_memory_id: memory.root_memory_id ?? memory.id },
      data: { root_memory_id: null },
    });
    await tx.memory_content__message.deleteMany({
      where: { memory_content: { memory_id: id } },
    });
    await tx.memory_content.deleteMany({ where: { memory_id: id } });
    await tx.memory__keyword.deleteMany({ where: { memory_id: id } });
    await tx.memory.update({
      where: { id },
      data: { deleted_at: new Date(), is_active: false, deactivated_at: new Date() },
    });
  });

  return memory;
}
```

- 이력(history) 버전들도 함께 삭제 대상인지: **root 기준 전체 lineage 삭제** — `findMemoryHistory`와 동일하게 `id = rootId OR root_memory_id = rootId`인 모든 버전을 순회하며 위 로직 적용. 특정 old 버전 하나만 삭제하는 UI는 없음 (feed-005 history 캐러셀에 버전별 삭제 버튼 없음 — 삭제는 `/memory` 카드 단위)
- Task 8(망각)에서도 이 repository 메서드를 그대로 재사용

## 3. Knowledge Memory Pin 토글

`PATCH /memory/knowledge/:id/pin` (body 없음, 토글) → `memoryService.togglePin(userId, id)`.

```typescript
// memory.repository.ts
async togglePin(userId: string, id: string) {
  const memory = await this.prisma.memory.findFirst({
    where: { id, user_id: userId, type: 'knowledge', is_active: true },
  });
  if (!memory) return null;

  const isPinned = !memory.is_pinned;
  const userActionScore = isPinned ? 1 : 0;
  const confirmedScore = clamp(
    0.4 * memory.explicit_signal + 0.3 * memory.repetition_strength +
    0.2 * userActionScore + 0.1 * memory.llm_confidence_hint,
  );
  const score = clamp(
    0.25 * memory.importance + 0.25 * memory.durability + 0.20 * memory.reusefulness +
    0.20 * confirmedScore + 0.10 * recencyOf(memory) -
    0.30 * memory.sensitivity - 0.30 * memory.temporary_penalty,
  );

  return this.prisma.memory.update({
    where: { id },
    data: {
      is_pinned: isPinned,
      user_action_score: userActionScore,
      confirmed_score: confirmedScore,
      score,
      scored_at: new Date(),
    },
  });
}
```

`recencyOf`: Spec 2와 동일한 recency 계산(`exp(-days/RECENCY_DECAY_FACTOR)`, `last_referenced_at ?? created_at` 기준)을 함수로 뽑아 `memory.repository.ts` 내부에서 saveMemory와 공유.

## 4. Knowledge Memory 수동 편집

`PUT /memory/knowledge/:id` body: `{ contents: string[], keywords: { code: string; name: string }[] }` → `memoryService.updateKnowledge(userId, id, dto)`.

기존 memory를 비활성화하고 새 버전 생성 — Spec 2 merge 로직과 동일한 패턴, LLM 호출 없이 유저 입력을 그대로 저장:

```typescript
// memory.repository.ts
async updateKnowledgeMemory(userId: string, id: string, contents: string[], keywords: { code: string; name: string }[]) {
  const existing = await this.prisma.memory.findFirst({
    where: { id, user_id: userId, type: 'knowledge', is_active: true },
  });
  if (!existing) return null;

  return this.prisma.$transaction(async (tx) => {
    await tx.memory.update({
      where: { id },
      data: { is_active: false, deactivated_at: new Date() },
    });

    const newMemory = await tx.memory.create({
      data: {
        user_id: userId,
        type: 'knowledge',
        history_type: 'modified',
        version: existing.version + 1,
        parent_memory_id: existing.id,
        root_memory_id: existing.root_memory_id ?? existing.id,
        is_pinned: existing.is_pinned,
        content: contents.join('\n'),
        summary: existing.summary, // summary는 Task 4 범위 밖 — 그대로 유지
        // score 컴포넌트는 기존 값 그대로 carry (재계산 안 함 — 유저가 내용만 고친 것)
        score: existing.score, sensitivity: existing.sensitivity, importance: existing.importance,
        durability: existing.durability, reusefulness: existing.reusefulness,
        explicit_signal: existing.explicit_signal, repetition_strength: existing.repetition_strength,
        user_action_score: existing.user_action_score, llm_confidence_hint: existing.llm_confidence_hint,
        confirmed_score: existing.confirmed_score, temporary_penalty: existing.temporary_penalty,
      },
    });

    for (const sentence of contents) {
      await tx.memory_content.create({ data: { memory_id: newMemory.id, content: sentence } });
      // 결정 C: message 근거 연결 없음
    }
    for (const kw of keywords) {
      await tx.$executeRaw`INSERT INTO keyword (code, name) VALUES (${kw.code.toLowerCase()}, ${kw.name}) ON CONFLICT (code) DO NOTHING`;
      await tx.$executeRaw`INSERT INTO memory__keyword (memory_id, keyword_code) VALUES (${newMemory.id}::uuid, ${kw.code.toLowerCase()}) ON CONFLICT DO NOTHING`;
    }
    await tx.$executeRaw`UPDATE memory SET embedding = (SELECT embedding FROM memory WHERE id = ${existing.id}::uuid) WHERE id = ${newMemory.id}::uuid`;

    return newMemory;
  });
}
```

- embedding은 원본(기존 버전)에서 그대로 복사 — 유저가 문장을 고쳤다고 매번 재임베딩(Ollama 호출)할 필요는 없다고 판단. 검색 정확도에 문제되면 추후 재검토
- 프론트 `/memory/[id]` 상세 페이지에 "편집" 버튼 추가 → contents/keywords inline 편집 폼 (textarea + keyword chip 추가/삭제), 저장 시 위 API 호출 후 `queryClient.invalidateQueries(['memory-history', id])`

## 5. Main Memory 조회 + 수동 편집

- `GET /memory/main` → `memoryService.getMainMemory(userId)` → `{ summary: string | null, updatedAt: string | null }`
- `PUT /memory/main` body `{ summary: string }` → `memoryService.updateMainMemory(userId, summary)`

```typescript
// memory.repository.ts
async updateMainMemory(userId: string, summary: string) {
  const existing = await this.prisma.memory.findFirst({
    where: { user_id: userId, type: 'main', is_active: true },
  });

  return this.prisma.$transaction(async (tx) => {
    if (existing) {
      await tx.memory.update({ where: { id: existing.id }, data: { is_active: false, deactivated_at: new Date() } });
    }
    return tx.memory.create({
      data: {
        user_id: userId, type: 'main', history_type: 'modified',
        version: existing ? existing.version + 1 : 1,
        parent_memory_id: existing?.id ?? null,
        root_memory_id: null,
        summary,
      },
    });
  });
}
```

- `getMainMemory`는 기존 `getActiveMainMemory` 쿼리에 `updated_at`(=생성 시각, `created_at`)만 추가해서 재사용
- 프론트: `/memory` 페이지 상단에 main memory 카드(요약 텍스트 + "편집" 버튼) 추가. 편집은 textarea 인라인

## 6. 키워드 대시보드

```typescript
// memory.repository.ts
async getKeywordDashboard(userId: string) {
  const decayFactor = this.config.get<number>('RECENCY_DECAY_FACTOR', 30);
  return this.prisma.$queryRaw<{ code: string; name: string; frequency: number; weight: number }[]>`
    SELECT k.code, k.name,
           COUNT(*)::int AS frequency,
           COUNT(*) + EXP(-EXTRACT(EPOCH FROM (NOW() - MAX(mk.created_at))) / 86400 / ${decayFactor}) AS weight
    FROM memory__keyword mk
    JOIN keyword k ON k.code = mk.keyword_code
    JOIN memory m ON m.id = mk.memory_id
    WHERE m.user_id = ${userId}::uuid AND m.type = 'knowledge' AND m.is_active = true AND m.deleted_at IS NULL
    GROUP BY k.code, k.name
    ORDER BY weight DESC
  `;
}
```

- `GET /memory/keywords` → 위 목록 반환
- `GET /memory/keywords/:code/memories` → 기존 `formatKnowledge` 재사용, `memory__keyword.keyword_code = :code` 필터만 추가된 목록 조회
- 프론트: `/keywords` 페이지 신규 — 키워드 배지 목록(weight 순), 클릭 시 `/memory?keyword=:code`로 이동 (기존 `/memory` 그리드에 keyword 쿼리 필터 파라미터 추가). `HeaderNav`에 `키워드` 링크 추가

## 7. md Import / Export

### Import

`POST /memory/import` body `{ content: string }` (프론트에서 `.md` 파일을 텍스트로 읽어 전송) → `memoryService.importKnowledge(userId, content)`.

- 결정 E에 따라 Spec 2 `callLlmForAnalysis`와 동일 프롬프트 재사용, `messages` 자리에 `[{ user: null, content }]` 형태 대신 업로드 원문 하나만 넣는 전용 프롬프트 변형 필요 (message_id 없음 — 애초에 근거 매핑 안 함, 결정 C)
- 저장 로직은 Task 4 `updateKnowledgeMemory`와 유사하지만 `existingMemory` 없음(항상 신규), `history_type: 'uploaded'`, `content`/`embedding`은 업로드 원문 기준 새로 생성 (`modelService.embedText(content)`)
- 중복 체크 없음 (plan.md 명시 — 매번 새 knowledge memory로 추가)

### Export

- `GET /memory/knowledge/:id/export` → `Content-Type: text/markdown`, body = `memory.content`
- `GET /memory/export` → 활성 knowledge memory 전체를 `\n\n---\n\n`로 join한 `.md`
- 컨트롤러에서 `res.setHeader('Content-Disposition', 'attachment; filename=...')` 후 raw 응답 (NestJS `@Res()` 사용, DTO/인터셉터 우회)
- 프론트: `/memory` 페이지에 "전체 내보내기" 버튼, `/memory/[id]`에 "내보내기" 버튼 + "가져오기"는 `/memory` 페이지에 파일 input(`accept=".md"`) 추가

## 8. 망각 옵션 (score 기반 자동 정리)

```bash
# .env
FORGETTING_ENABLED=false
FORGETTING_SCORE_THRESHOLD=0.2
FORGETTING_STALE_DAYS=60
```

```typescript
// memory/forgetting.scheduler.ts
@Cron('0 1 * * *')  // decay 이후 시각대(00:00 UTC decay, 01:00 UTC forgetting)
async applyForgetting() {
  if (!this.config.get<boolean>('FORGETTING_ENABLED', false)) return;
  const threshold = this.config.get<number>('FORGETTING_SCORE_THRESHOLD', 0.2);
  const staleDays = this.config.get<number>('FORGETTING_STALE_DAYS', 60);

  const candidates = await this.memoryRepo.findForgettingCandidates(threshold, staleDays);
  for (const { user_id, id } of candidates) {
    await this.memoryRepo.deleteKnowledgeMemory(user_id, id); // Task 2 재사용
  }
}
```

```typescript
// memory.repository.ts
async findForgettingCandidates(scoreThreshold: number, staleDays: number) {
  return this.prisma.$queryRaw<{ user_id: string; id: string }[]>`
    SELECT user_id, id FROM memory
    WHERE type = 'knowledge' AND is_active = true AND deleted_at IS NULL
      AND is_pinned = false AND score < ${scoreThreshold}
      AND COALESCE(last_referenced_at, created_at) < NOW() - (${staleDays} || ' days')::interval
  `;
}
```

`MemoryModule`에 `ForgettingScheduler` provider 추가.

---

## 영향 범위

- `apps/backend/prisma/schema.prisma` — `memory.deleted_at` 추가
- `apps/backend/src/memory/memory.repository.ts` — Task 2~8 메서드 추가 (`recencyOf` 공통 함수 추출)
- `apps/backend/src/memory/memory.service.ts` — 위 메서드 각각의 얇은 wrapper + `formatKnowledge` 재사용
- `apps/backend/src/memory/memory.controller.ts` — 라우트 추가 (`DELETE/PATCH/PUT /memory/knowledge/:id`, `GET/PUT /memory/main`, `GET /memory/keywords`, `GET /memory/keywords/:code/memories`, `POST /memory/import`, `GET /memory/export`, `GET /memory/knowledge/:id/export`)
- `apps/backend/src/memory/forgetting.scheduler.ts` — 신규
- `apps/backend/src/memory/memory.module.ts` — `ForgettingScheduler` 등록
- `apps/backend/.env` / `.env.example` — `FORGETTING_*` 3개 추가
- `apps/frontend/src/app/memory/page.tsx` — main memory 카드, keyword 쿼리 필터, import/export 버튼
- `apps/frontend/src/app/memory/[id]/page.tsx` — 편집/삭제/pin/export 버튼
- `apps/frontend/src/app/keywords/page.tsx` — 신규
- `apps/frontend/src/components/header-nav.tsx` — `키워드` 링크 추가
