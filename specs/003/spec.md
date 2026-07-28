# Spec 003 — 지식 관리 & 키워드

## 목표

knowledge memory를 유저가 직접 편집/고정/삭제할 수 있게 하고, main memory 조회/편집, 키워드 대시보드, md import/export, score 기반 망각(forgetting) 옵션을 구현한다. 겸사겸사 Spec 2에서 빠진 score 재계산 연동(decay가 score에 반영 안 되던 버그)과 승격 로직(threshold만 쓰던 것)도 고친다.

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
- [ ] (9) score 재계산 공통화 — decay/반복강도 갱신에 연동
- [ ] (10) main memory 승격 로직 개선 (이중 threshold + top-N)

---

## 결정 사항 (초안 — feedback 필요)

| # | 항목 | 제안 |
|---|------|------|
| A | 삭제 방식 | soft delete. `memory.deleted_at` 추가, 삭제 시 `deleted_at=now()` + 연결된 `memory_content`/`memory_content__message`/`memory__keyword` row는 실제 삭제(hard delete) — plan.md "relation은 제거" 문구 반영. `message` 원본은 손대지 않음 |
| B | 삭제 시 message 처리 | 재처리(재생성)는 안 함 — `is_proceeded=true` 유지. `root_memory_id`는 무조건 null 처리하지 않고, 삭제 후에도 `memory_content__message`에 다른 memory 근거로 남아있는지(N:M이라 가능) 확인해서 완전히 퇴출된 message만 null 처리 |
| C | 수동 편집/import 시 문장별 message 근거 필요 여부 | **불필요** — Spec 2에서 정한 "근거 없는 문장 금지" 불변조건은 LLM 자동 생성(`created`/`renewed`)에만 적용. `history_type='modified'`(수동편집)/`uploaded`(import)는 유저 본인이 근거이므로 `memory_content__message` 연결 없이 저장 |
| D | 키워드 가중치 공식 | 가중치(weight) 없음 — 배치마다 키워드가 다시 계산돼서 가중치 자체가 불안정. `frequency`(해당 keyword가 걸린 active knowledge memory 수)만 계산해서 그걸로 정렬 |
| E | import 시 LLM 분석 | `callLlmForAnalysis`(exchange/merge용) 재사용 안 함 — import 전용 별도 분석 함수 사용, merge 체크 없음(plan.md "중복 체크 없이" 그대로). knowledge → main 승격은 import와 무관한 독립 파이프라인이라 import가 신경 쓸 필요 없음 (다음 배치에서 알아서 처리됨) |
| F | export 포맷 | 단건: `GET /memory/knowledge/:id/export` → 해당 memory의 `content`를 `.md` 텍스트로 응답. 전체: `GET /memory/export` → 활성 knowledge memory 전체를 `---`로 구분해 하나의 `.md`로 응답 |
| G | 망각 옵션 on/off 단위 | 유저별 설정 UI는 Spec 4(설정 페이지) 범위라 이번엔 제외. 전역 `.env` 플래그(`FORGETTING_ENABLED`)로 on/off, 켜져 있으면 전체 유저 대상 매일 배치 실행 |
| H | pin 토글 시 점수 재계산 | ~~철회~~ — pin은 score 공식과 무관(승격 체크에서 OR로만 우회). 단순 `is_pinned` 토글만 함, 재계산 없음 |

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

삭제는 특정 버전 하나가 아니라 **root 기준 전체 버전**(history 전부) 대상 — feed-005 history 캐러셀에 버전별 삭제 버튼이 없고, 삭제는 `/memory` 카드 단위이기 때문.

```typescript
// memory.repository.ts
async deleteKnowledgeMemory(userId: string, id: string) {
  const target = await this.prisma.memory.findFirst({
    where: { id, user_id: userId, type: 'knowledge', deleted_at: null },
    select: { id: true, root_memory_id: true },
  });
  if (!target) return null;
  const rootId = target.root_memory_id ?? target.id;

  const versionIds = (await this.prisma.memory.findMany({
    where: { user_id: userId, type: 'knowledge', OR: [{ id: rootId }, { root_memory_id: rootId }] },
    select: { id: true },
  })).map(v => v.id);

  await this.prisma.$transaction(async (tx) => {
    await tx.memory_content__message.deleteMany({ where: { memory_content: { memory_id: { in: versionIds } } } });
    await tx.memory_content.deleteMany({ where: { memory_id: { in: versionIds } } });
    await tx.memory__keyword.deleteMany({ where: { memory_id: { in: versionIds } } });
    await tx.memory.updateMany({
      where: { id: { in: versionIds } },
      data: { deleted_at: new Date(), is_active: false, deactivated_at: new Date() },
    });

    // memory_content__message는 N:M이라 message 하나가 다른(삭제 대상 아닌) memory의
    // 근거로 여전히 쓰이고 있을 수 있음 — 완전히 퇴출된 message만 root_memory_id를 null로 리셋
    const candidates = await tx.message.findMany({ where: { root_memory_id: rootId }, select: { id: true } });
    const stillReferenced = new Set(
      (await tx.memory_content__message.findMany({
        where: { message_id: { in: candidates.map(m => m.id) } },
        select: { message_id: true },
        distinct: ['message_id'],
      })).map(r => r.message_id),
    );
    const toReset = candidates.map(m => m.id).filter(mid => !stillReferenced.has(mid));

    await tx.message.updateMany({ where: { id: { in: toReset } }, data: { root_memory_id: null } });
  });
}
```

### `deleted_at` 필터 반영 대상 (기존 쿼리 전체 점검)

`memory` 테이블에 `deleted_at`이 생기는 순간, 그 테이블을 조회하는 모든 쿼리에 `deleted_at IS NULL`을 명시해야 함(`docs/conventions.md` — 다른 플래그가 우연히 걸러주더라도 생략 금지). Spec 2에서 만든 것 중 반영 안 된 곳:

- `memory.repository.ts`
  - `findKnowledgeMemory`, `findMemoryHistory` — 지금 `is_active` 필터도 없어서 삭제된 memory를 `GET /memory/knowledge/:id`·`.../history`로 직접 조회하면 그대로 나옴. **가장 중요한 반영 대상**
  - `getKnowledgeList`, `getTopKnowledge`, `findSimilarMemory`, `findPromotedMemories` — `is_active = true`가 이미 있어서 지금 당장 새는 곳은 아니지만, 컨벤션대로 명시적으로 추가
  - `getActiveMainMemory`, `findMainMemory` — main memory는 이번 Spec에서 삭제 기능이 없지만 컬럼이 테이블 전체에 걸리므로 동일하게 추가
  - `applyDecay`(decay.scheduler 대상 쿼리), `updateRepetitionStrength`의 기존 memory 조회 — 동일하게 추가
- 이번 Spec에서 새로 추가하는 쿼리(Task 3 `togglePin`, Task 4 `updateKnowledgeMemory`, Task 6 `getKeywordDashboard`와 키워드별 목록 조회)도 처음부터 `deleted_at: null` 포함해서 작성

## 3. Knowledge Memory Pin 토글

`PATCH /memory/knowledge/:id/pin` (body 없음, 토글) → `memoryService.togglePin(userId, id)`.

단순 토글 — score 재계산 없음. `is_pinned`은 score 공식과 무관하고(`user_action_score`도 지금 항상 0으로 고정돼있어 pin과 연결 안 돼있음), 승격 체크(`is_pinned OR score>threshold`)에서 OR로 우회시키는 용도로만 쓰이므로 그걸로 충분함.

pin 개수 제한 — 무제한으로 두면 승격 체크 우회가 무의미해짐(전부 pin하면 전부 main memory 재료가 됨). `.env`에 `PIN_MAX_COUNT=20` 추가, pin(→true) 시에만 체크(unpin은 항상 허용):

```bash
# .env
PIN_MAX_COUNT=20
```

```typescript
// memory.repository.ts
async togglePin(userId: string, id: string) {
  const memory = await this.prisma.memory.findFirst({
    where: { id, user_id: userId, type: 'knowledge', is_active: true, deleted_at: null },
  });
  if (!memory) return null;

  if (!memory.is_pinned) {
    const maxPinned = Number(this.config.get('PIN_MAX_COUNT', 20));
    const pinnedCount = await this.prisma.memory.count({
      where: { user_id: userId, type: 'knowledge', is_active: true, deleted_at: null, is_pinned: true },
    });
    if (pinnedCount >= maxPinned) throw new Error('PIN_LIMIT_EXCEEDED');
  }

  return this.prisma.memory.update({
    where: { id },
    data: { is_pinned: !memory.is_pinned },
  });
}
```

컨트롤러에서 `PIN_LIMIT_EXCEEDED` catch해서 `BadRequestException`(400)으로 변환.

## 4. Knowledge Memory 수동 편집

`PUT /memory/knowledge/:id` body: `{ contents: string[], summary: string }` → `memoryService.updateKnowledge(userId, id, contents, summary)`.

`summary`를 같이 받아서 갱신 — RAG 컨텍스트 주입(`chat.service.ts`)과 main memory 합성 입력은 `content`가 아니라 `summary`를 쓰기 때문에, `contents`만 고치고 `summary`를 그대로 두면 실제 채팅엔 반영이 안 됨. chat 이후 `message_content` 갱신하는 것과 같은 패턴으로 유저가 직접 입력한 값을 그대로 저장(LLM 재생성 없음).

keyword 편집 UI/API는 이번 Task에 없음 — 편집 폼은 contents/summary만 다룬다. keyword는 기존 값을 그대로 새 버전에 복사 (todo.md 참고, keyword 편집은 별도 고민 필요).

기존 memory를 비활성화하고 새 버전 생성 — Spec 2 merge 로직과 동일한 패턴, LLM 호출 없이 유저 입력을 그대로 저장:

```typescript
// memory.repository.ts
async updateKnowledgeMemory(userId: string, id: string, contents: string[], summary: string) {
  const existing = await this.prisma.memory.findFirst({
    where: { id, user_id: userId, type: 'knowledge', is_active: true, deleted_at: null },
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
        summary,
        // score 컴포넌트는 기존 값 그대로 carry (재계산 안 함 — 유저가 내용만 고친 것)
        score: existing.score, sensitivity: existing.sensitivity, importance: existing.importance,
        durability: existing.durability, reusefulness: existing.reusefulness,
        explicit_signal: existing.explicit_signal, repetition_strength: existing.repetition_strength,
        user_action_score: existing.user_action_score, llm_confidence_hint: existing.llm_confidence_hint,
        confirmed_score: existing.confirmed_score, temporary_penalty: existing.temporary_penalty,
        scored_at: existing.scored_at, last_referenced_at: existing.last_referenced_at,
        reference_count: existing.reference_count,
      },
    });

    for (const sentence of contents) {
      await tx.memory_content.create({ data: { memory_id: newMemory.id, content: sentence } });
      // 결정 C: message 근거 연결 없음
    }
    // keyword는 편집 대상이 아니므로 기존 값 그대로 복사 (안 하면 Spec2에서 고친 것과 같은 유실 버그 재발)
    await tx.$executeRaw`
      INSERT INTO memory__keyword (memory_id, keyword_code)
      SELECT ${newMemory.id}::uuid, keyword_code FROM memory__keyword WHERE memory_id = ${existing.id}::uuid
      ON CONFLICT DO NOTHING
    `;
    await tx.$executeRaw`UPDATE memory SET embedding = (SELECT embedding FROM memory WHERE id = ${existing.id}::uuid) WHERE id = ${newMemory.id}::uuid`;

    return newMemory;
  });
}
```

- embedding은 원본(기존 버전)에서 그대로 복사 — 유저가 문장을 고쳤다고 매번 재임베딩(Ollama 호출)할 필요는 없다고 판단. 검색 정확도에 문제되면 추후 재검토
- 프론트 `/memory/[id]` 상세 페이지에 "편집" 버튼 추가 → contents + summary inline 편집 폼(textarea 2개, keyword 편집 UI 없음), 저장 시 위 API 호출 후 `queryClient.invalidateQueries(['memory-history', id])`

## 5. Main Memory 조회 + 수동 편집

- `GET /memory/main` → `memoryService.getMainMemory(userId)` → `{ summary: string | null, updatedAt: string | null }`
- `PUT /memory/main` body `{ summary: string }` → `memoryService.updateMainMemory(userId, summary)`

새 메서드를 만들지 않고 Spec 2의 `saveMainMemory`(memory.repository.ts, 지금은 `SchedulerService.updateMainMemory`에서만 호출)를 재사용 — 비활성화→새 버전 생성 로직이 거의 동일하므로 `historyType` 파라미터만 추가:

```typescript
// memory.repository.ts — 기존 saveMainMemory 확장 (기본값 'renewed'라 기존 호출부는 변경 없음)
async saveMainMemory(
  userId: string,
  summary: string,
  existing: { id: string; version: number } | null,
  historyType: 'renewed' | 'modified' = 'renewed',
) {
  const now = new Date();
  if (existing) {
    await this.prisma.memory.update({ where: { id: existing.id }, data: { is_active: false, deactivated_at: now } });
  }
  return this.prisma.memory.create({
    data: {
      user_id: userId, type: 'main', history_type: historyType,
      version: existing ? existing.version + 1 : 1,
      parent_memory_id: existing?.id ?? null,
      root_memory_id: null,
      summary,
    },
  });
}
```

`memory.service.ts`의 `updateMainMemory(userId, summary)`는 `findMainMemory(userId)`로 기존 값 조회 후 `saveMainMemory(userId, summary, existing, 'modified')` 호출만 하는 얇은 wrapper.

- `getMainMemory`는 기존 `findMainMemory`(`{id, version, summary}` 반환, `SchedulerService`가 `existing` 조회할 때 쓰는 것)의 `select`에 `created_at`만 추가해서 재사용 — `getActiveMainMemory`는 `chat.service.ts` RAG 핫패스용으로 일부러 `summary` 문자열만 반환하게 만든 것이라 건드리지 않음
- 프론트: `/memory` 페이지 상단에 main memory 카드(요약 텍스트 + "편집" 버튼) 추가. 편집은 textarea 인라인

## 6. 키워드 대시보드

```typescript
// memory.repository.ts
async getKeywordDashboard(userId: string) {
  return this.prisma.$queryRaw<{ code: string; name: string; frequency: number }[]>`
    SELECT k.code, k.name, COUNT(*)::int AS frequency
    FROM memory__keyword mk
    JOIN keyword k ON k.code = mk.keyword_code
    JOIN memory m ON m.id = mk.memory_id
    WHERE m.user_id = ${userId}::uuid AND m.type = 'knowledge' AND m.is_active = true AND m.deleted_at IS NULL
    GROUP BY k.code, k.name
    ORDER BY frequency DESC
  `;
}
```

- `GET /memory/keywords` → 위 목록 반환
- `GET /memory/keywords/:code/memories` → 기존 `formatKnowledge` 재사용, `memory__keyword.keyword_code = :code` 필터만 추가된 목록 조회
- 프론트 UI(`/keywords` 페이지, `HeaderNav` 링크) 없음 — 이번 Task는 백엔드 API까지만. 프론트는 todo.md 참고

## 7. md Import / Export

### Import

`POST /memory/import` body `{ content: string }` (프론트에서 `.md` 파일을 텍스트로 읽어 전송) → `memoryService.importKnowledge(userId, content)`.

- 결정 E — merge 체크 없음, `callLlmForAnalysis`(exchange/merge용) 재사용 안 함. import 전용 별도 분석 함수(`callLlmForImport(userId, content)`)로 업로드 원문 하나를 분석해 keywords/summary/점수 산정 (문장 근거 매핑 없음, 결정 C)
- score/confirmed_score는 Spec 2 `saveMemory`의 공식을 그대로 재사용 — `cluster_size_score`는 `cluster_size = 1`로 계산(단일 메시지 케이스와 동일 취급), `scored_at`도 그때(now)로 세팅
- 저장은 Task 4 `updateKnowledgeMemory`와 유사하지만 `existingMemory` 없음(항상 신규), `history_type: 'uploaded'`, `content`/`embedding`은 업로드 원문 기준 새로 생성 (`modelService.embedText(content)`)
- 중복 체크 없음 (plan.md 명시 — 매번 새 knowledge memory로 추가). knowledge → main 승격은 이 작업과 무관 — 다음 배치가 알아서 점수 보고 승격 여부 판단

### Export

- `GET /memory/knowledge/:id/export` → `Content-Type: text/markdown`, body = `memory.content` (조회 시 `deleted_at IS NULL` 조건 포함)
- `GET /memory/export` → 활성 knowledge memory 전체(`is_active AND deleted_at IS NULL`)를 `\n\n---\n\n`로 join한 `.md`
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
  // config.get<boolean>()도 number와 같은 문제 — env string "false"가 truthy라 !enabled가 항상 false가 됨
  if (this.config.get('FORGETTING_ENABLED', 'false') !== 'true') return;
  const threshold = Number(this.config.get('FORGETTING_SCORE_THRESHOLD', 0.2));
  const staleDays = Number(this.config.get('FORGETTING_STALE_DAYS', 60));

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

`MemoryModule`에 `ForgettingScheduler` provider 추가. `deleteKnowledgeMemory`는 root 기준 전체 lineage를 지우므로, `findForgettingCandidates`가 lineage 안의 여러 버전을 각각 candidate로 반환해도 먼저 처리된 버전에서 이미 전체 lineage가 삭제돼 있어 이후 호출은 `target`을 못 찾고 조용히 no-op — 중복 실행 안전함.

## 9. Score 재계산 공통화 — decay/반복강도 갱신에 연동

지금 `confirmed_score`/`score` 계산식은 `saveMemory`(memory.repository.ts) 딱 한 곳에서만 쓰이는데, Task 7(import)에서 또 필요해지고, decay/`updateRepetitionStrength`도 `repetition_strength`만 바꾸고 `score`는 재계산 안 해서 decay가 사실상 무의미했음(방치된 memory의 score가 생성 당시 값에 영구 고정). 공식이 여러 곳에 퍼지면 지금까지 두 번(user_action_score 하드코딩 0, decay 미반영) 버그가 났으니 공유 함수로 뽑는다. DB 함수 대신 TS 함수 — Repository 패턴상 로직은 서비스/리포지토리 레이어에서 검증 가능해야 함(`docs/conventions.md`).

```typescript
// memory.repository.ts
function computeScore(
  m: {
    importance: number; durability: number; reusefulness: number;
    explicit_signal: number; repetition_strength: number; user_action_score: number; llm_confidence_hint: number;
    sensitivity: number; temporary_penalty: number;
    last_referenced_at: Date | null; created_at: Date;
  },
  recencyDecayFactor: number,
): { confirmedScore: number; score: number } {
  const confirmedScore = clamp(
    0.4 * m.explicit_signal + 0.3 * m.repetition_strength +
    0.2 * m.user_action_score + 0.1 * m.llm_confidence_hint,
  );
  const days = (Date.now() - (m.last_referenced_at ?? m.created_at).getTime()) / 86400000;
  const recency = Math.exp(-days / recencyDecayFactor);
  const score = clamp(
    0.25 * m.importance + 0.25 * m.durability + 0.20 * m.reusefulness +
    0.20 * confirmedScore + 0.10 * recency -
    0.30 * m.sensitivity - 0.30 * m.temporary_penalty,
  );
  return { confirmedScore, score };
}
```

- `saveMemory`(Spec 2): 기존 인라인 계산을 `computeScore(...)` 호출로 교체 (동작 동일, 리팩토링만)
- Task 7 import: 같은 함수 재사용
- `updateRepetitionStrength`(Spec 2, memory.repository.ts): 지금은 `id`/`embedding`만 raw SQL로 조회 후 `repetition_strength`만 raw UPDATE함. `computeScore` 쓰려면 필요한 컬럼(importance, durability, ... last_referenced_at, created_at)까지 같이 SELECT하고, 유사도 조건 통과한 row마다 새 `repetition_strength` 계산 → `computeScore` 호출 → `tx.memory.update`로 `repetition_strength`/`confirmed_score`/`score`/`scored_at` 한 번에 저장 (raw UPDATE 대신 Prisma typed update로 전환)
- `decay.scheduler.ts`/`applyDecay`(Spec 2): 지금은 `WHERE type='knowledge' AND is_active=true`인 전체 row를 SQL 한 방으로 `repetition_strength *= 0.995` UPDATE함. `computeScore` 쓰려면 row들을 TS로 fetch해서 각각 재계산 후 개별 `update`로 전환 필요 — set-based 1개 UPDATE에서 row-by-row로 바뀜(유저 개인용 토이 프로젝트라 row 수 적어 성능 문제 없다고 판단, **임의 선택 — 데이터 많아지면 재검토**):

```typescript
// decay.scheduler.ts 또는 memory.repository.ts의 applyDecay
async applyDecay() {
  const recencyDecayFactor = Number(this.config.get('RECENCY_DECAY_FACTOR', 30));
  const memories = await this.prisma.memory.findMany({
    where: { type: 'knowledge', is_active: true, deleted_at: null },
  });
  for (const m of memories) {
    const repetitionStrength = Math.min(1, Math.max(0, m.repetition_strength * 0.995));
    const { confirmedScore, score } = computeScore({ ...m, repetition_strength: repetitionStrength }, recencyDecayFactor);
    await this.prisma.memory.update({
      where: { id: m.id },
      data: { repetition_strength: repetitionStrength, confirmed_score: confirmedScore, score, scored_at: new Date() },
    });
  }
}
```

## 10. Main Memory 승격 로직 개선 (이중 threshold + top-N)

`findPromotedMemories`(Spec 2, memory.repository.ts)를 threshold 단독 방식에서 "threshold 통과 + top-N" 방식으로 변경. `PROMOTION_SENSITIVITY_THRESHOLD`는 그대로 절대 게이트 유지(민감정보를 main memory에 안 넣기 위한 안전장치라 랭킹과 무관 — score 공식에도 sensitivity가 이미 감점 요소로 들어가지만, 다른 요소로 상쇄돼 threshold를 넘는 경우까지 막기 위한 이중 체크). `is_pinned=true`는 랭킹과 무관하게 항상 전부 포함(개수 제한은 Task 3 `PIN_MAX_COUNT`가 이미 담당).

top-N의 N은 로그 스케일로(정확한 공식 근거는 없음 — **임의 선택**, 기존 `cluster_size_score` 정규화 패턴 참고):

```typescript
// memory.repository.ts
async findPromotedMemories(userId: string, scoreThreshold: number, sensitivityThreshold: number) {
  const totalActive = await this.prisma.memory.count({
    where: { user_id: userId, type: 'knowledge', is_active: true, deleted_at: null },
  });
  const topN = Math.max(3, Math.ceil(Math.log2(totalActive + 1))); // 임의 선택 — 근거 없음, 최소 3 보장

  const ranked = await this.prisma.memory.findMany({
    where: {
      user_id: userId, type: 'knowledge', is_active: true, deleted_at: null, is_pinned: false,
      score: { gt: scoreThreshold }, sensitivity: { lte: sensitivityThreshold },
    },
    orderBy: { score: 'desc' },
    take: topN,
    select: { summary: true },
  });

  const pinned = await this.prisma.memory.findMany({
    where: { user_id: userId, type: 'knowledge', is_active: true, deleted_at: null, is_pinned: true },
    select: { summary: true },
  });

  return [...ranked, ...pinned];
}
```

`SchedulerService.updateMainMemory`의 트리거 판단(이번 배치 `batchResults` 중 threshold 넘은 게 있는지)은 그대로 유지 — top-N은 "누구를 LLM 프롬프트에 넣을지" 선정 단계에서만 추가로 적용되는 cap이라 트리거 로직 안 건드려도 됨.

---

## 영향 범위

- `apps/backend/prisma/schema.prisma` — `memory.deleted_at` 추가
- `apps/backend/src/memory/memory.repository.ts` — Task 2~8 메서드 추가, `computeScore` 공유 함수 추가(Task 9), `saveMemory`/`updateRepetitionStrength`/`findPromotedMemories` 수정(Task 9/10) — Spec 2 기존 코드 변경
- `apps/backend/src/memory/decay.scheduler.ts` — `applyDecay` row-by-row 재계산으로 변경(Task 9) — Spec 2 기존 코드 변경
- `apps/backend/src/memory/memory.service.ts` — 위 메서드 각각의 얇은 wrapper + `formatKnowledge` 재사용
- `apps/backend/src/memory/forgetting.scheduler.ts` — 신규
- `apps/backend/src/memory/memory.module.ts` — `ForgettingScheduler` 등록
- `apps/backend/.env` / `.env.example` — `PIN_MAX_COUNT=20`, `FORGETTING_*` 3개 추가
- `apps/backend/src/memory/memory.controller.ts` — 라우트 추가 (`DELETE/PATCH/PUT /memory/knowledge/:id`, `GET/PUT /memory/main`, `GET /memory/keywords`, `GET /memory/keywords/:code/memories`, `POST /memory/import`, `GET /memory/export`, `GET /memory/knowledge/:id/export`)
- `apps/frontend/src/app/memory/page.tsx` — main memory 카드, import/export 버튼
- `apps/frontend/src/app/memory/[id]/page.tsx` — 편집/삭제/pin/export 버튼. 편집/삭제/pin은 최신(active, `version` 최댓값) 카드에만 노출 — 백엔드가 `is_active: true`인 것만 처리하므로 과거 버전 카드엔 안 붙임. export는 버전 무관하게 모든 카드에 노출 가능
