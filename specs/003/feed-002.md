# Spec-003 Feedback — 점수를 memory_content 단위로 이전

## 배경

현재 `importance`/`durability`/`reusefulness`/`sensitivity`/`explicit_signal`/`llm_confidence_hint`/`temporary_penalty`/`score`/`repetition_strength` 전부 `memory`(버전) 테이블에 있음. 이 때문에:

- `saveMemory`가 새 버전 만들 때 `analysis.contents`로 `memory.content`를 **완전 치환**함 (`content: validPairs.map(p => p.sentence).join('\n')`) — 기존 문장 중 이번 배치에서 언급 안 된 것도 사라질 위험 있음. 프롬프트 지침("기존 기억 최대한 유지, 중복 추가 안 함")과 실제 코드(완전 치환) 사이 모순.
- `todo.md`의 `memory_content.is_user_defined` 항목도 같은 근본 원인(문장 단위 생명주기가 없어서 버전 갱신 때마다 통째로 재해석됨).

문장(memory_content) 단위로 점수/embedding을 갖게 하면, 버전 갱신 시 안 바뀐 문장은 그대로 carry, 새로 언급된 문장만 추가하는 구조가 자연스러워짐. `memory`는 문장들을 묶어서 보여주는 그룹(요약/버전 이력 용도)으로 역할 축소.

또 다른 이유: LLM은 매 배치마다 **새로 등장한 문장**만 판단하게 하고, 오래된 문장의 aging/forgetting은 LLM 재판단 없이 `memory_content` 자체의 점수/시간으로만 독립적으로 처리하고 싶음. 즉 content는 memory 버전 갱신 주기에 종속되지 않고 스스로 태어나고(신규 insert) 비활성화되는(forgetting, 삭제 아님 — F 참고) 단위가 되어야 함 — 그러려면 `memory`와 `memory_content`는 1:N이 아니라 **N:M**이어야 함 (문장 하나가 여러 버전에 걸쳐 그대로 재사용/참조되어야 하므로, 버전 바뀔 때마다 복사하거나 재배정하면 content의 독립적 생명주기가 버전에 다시 묶여버림).

또한 memory 버전은 이미 전부 이력으로 남기고 있어서(soft delete만 함, 실제 row 삭제 없음), 망각을 "공간 확보용 삭제"로 볼 필요가 없음 — 우선은 "이 content가 계속 active memory로 유지돼야 하는지"를 `memory__memory_content` 관계 존재 여부로만 다루고(F 참고), 실제 물리 삭제는 나중 문제로 미룸.

## 태스크

- [ ] (1) `temporary_penalty`를 `durability`로 통합 (의미 중복 제거)
- [ ] (2) LLM 분석 출력을 문장(content)별 점수 구조로 변경
- [ ] (3) DB: `memory`↔`memory_content`를 N:M으로 전환(`memory__memory_content` 조인 테이블 추가, `seq`도 이 테이블로), 점수/embedding 컬럼을 `memory_content`로 이전하고 `memory`에서 제거
- [ ] (4) `saveMemory`: 버전 생성 시 기존 content 중 score/staleDays 조건 통과한 것만 조인 추가(forgotten은 제외), 새 문장만 insert
- [ ] (5) "재언급" 감지를 embedding 검색 기반 count로 교체 (`repetition_strength` 공식 → count)
- [ ] (6) 승격(promotion): content 단위로 topN 추출
- [ ] (7) 망각(forgetting): `ForgettingScheduler`가 candidate 있는 memory에 대해 carry-only `saveMemory` 호출을 트리거해서 관계에서 제외 (삭제/플래그 아님)
- [ ] (8) Decay(`applyDecay`) 대상을 `memory` → `memory_content`로 이전

---

## 결정 사항 (초안 — feedback 필요)

| # | 항목 | 제안                                                                                                                                                                                                                                                                                                                                                                                                  |
|---|------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| A | `temporary_penalty` 통합 방식 | 필드는 삭제하고 `durability` 하나로 흡수 (프롬프트 정의 자체가 서로 반대 방향 동어반복이었음). score 공식의 `0.25*durability - 0.30*temporary_penalty` 두 항을 `0.30*durability` 하나로 대체 — penalty 쪽이 원래 더 세게 반영됐던 비대칭(0.30 > 0.25)을 유지하려고 0.30 채택. **가중치 숫자 자체는 임의 선택 — 근거 없음**                                                                                                                                                             |
| B | 버전 생성 단위 | 배치 처리 결과 **실제로 새 문장이 생긴 경우에만** 새 버전 생성. content 제거(forgetting)는 이 흐름과 무관하게 별도 프로세스가 처리하며, 그때는 새 memory 버전을 만들지 않음(F 참고) — 안 건드린 memory는 버전 그대로 (지금 구조도 group→existingMemory 1:1이라 그룹 자체는 이미 이렇게 동작 중, 이번 스펙은 "새 버전의 content 구성 방식"만 바꾸는 것)                                                                                                                                                        |
| C | `memory`↔`memory_content` 관계 및 새 버전의 content 구성 | 기존 1:N(`memory_content.memory_id`)을 **N:M**으로 변경 — 조인 테이블 `memory__memory_content(memory_id, memory_content_id)` 추가. 새 버전 row 생성 시, 기존 활성(F 참고) `memory_content`는 복사/재배정 없이 **조인 row만 새 버전에 대해 추가**(content 자체는 손 안 댐, id·score·embedding·repetition_count 등 그대로). 신규 문장만 LLM 분석 결과로 새 `memory_content` insert 후 조인. 옛 버전의 조인 row도 그대로 남기 때문에 버전 히스토리가 안 깨짐. "중복 판단"(의미상 겹치는 문장 거르기)은 여전히 LLM이 함 — 완전 보장은 안 됨                          |
| D | carry된 문장의 재언급 count | (C가 N:M으로 바뀌면서 자동 해소됨) 복사/재배정을 안 하므로 애초에 같은 row — count는 그대로 유지됨을 신경 쓸 필요 없음                                                                                                                                                                                                                                                                                                                        |
| E | 승격(promotion) 대상 | 지금은 `memory.summary`를 승격 재료로 씀 (`scheduler.service.ts:247` `newKnowledges = promoted.map(m => m.summary)`). content 단위로 내리면서 **개별 문장(`memory_content.content`)을 직접 승격 재료로 사용**하도록 변경 — summary 대신 실제 고득점 문장들을 `synthesizeMainMemory`에 넘김. topN은 기존에는 memory 개수로 해두었지만(`Math.max(3, log2(totalActiveMemory+1))`), memory_content 단위로 바꾸면서 임의로 기존 공식에 `*5`를 곱해두었음 — 실질적인 전략은 추후에 재조정 필요(`todo.md` 기록)                                          |
| F | 망각(forgetting)의 의미 | **별도 컬럼 없이, `memory__memory_content` 관계 존재 여부 자체로 "활성 여부"를 표현.** memory 버전을 이미 전부 이력으로 남기고 있어서, 지금 당장 공간 확보용 삭제는 필요 없음 — 실제 row 삭제(공간 확보)는 나중 문제로 미룸(`todo.md`). 판정(score/staleDays)에 쓰는 필터 로직은 `saveMemory`의 carry 단계(4번)와 동일한 걸 재사용. **`ForgettingScheduler`는 유지** — 매일 대상 memory를 훑어서 forgetting candidate가 있으면, 새 메시지가 없어도 **"새 문장 없이 carry만 하는 saveMemory 호출"**로 새 버전을 만들어 forgotten content의 관계를 새 버전에서 빼버림(그래야 채팅이 뜸한 유저도 시간 지나면 실제로 active 목록에서 빠짐 — 채팅 트리거만 기다리지 않음). 과거 버전의 관계는 안 건드림(히스토리 보존). "새 버전에 조인된 content가 0개면 memory도 soft delete" 로직은 그대로 유지 |
| G | keyword/summary | 이번 스펙 범위 아님 — 계속 memory(그룹) 단위 유지. summary는 그룹 전체 요약 표시용으로 남기고, 승격 로직만 content 기반으로 바꿈(E 참고)                                                                                                                                                                                                                                                                                                        |
| H | `TOP_K` → `TOP_N` 네이밍 통일 | 이번 스펙에서 promotion topN을 새로 도입하면서, 기존 RAG 검색 쪽 `TOP_K` 네이밍과 안 맞음 — `TOP_N`으로 통일. 대상: `.env`의 `RAG_TOP_K` → `RAG_TOP_N`, `memory.repository.ts:337`/`memory.service.ts:18` `getTopKnowledge(..., topK)` 파라미터명 → `topN`. `specs/002/spec.md`는 이미 적용된 과거 기록이라 안 건드림                                                                                                                                              |
| I | Decay 대상 이전 | `applyDecay`(`memory.repository.ts:630`)가 아직 `memory` 테이블 기준으로 돎 — 점수 필드가 `memory_content`로 이전되므로 이것도 `memory_content`(활성 memory에 조인된 것) 기준으로 바꿔야 함. `repetition_strength *= 0.995` 감쇠 로직은 제거(count는 감쇠 안 함, 5번 참고), recency 기반 score만 재계산해서 `score`/`confirmed_score`/`scored_at` 갱신                                                                                                                                                    |

---

## 1. `temporary_penalty` → `durability` 통합

### 프롬프트 (`system-chat.service.ts`)

`analyzeConversation`의 점수 지침에서 `temporary_penalty` 항목 제거, `durability` 설명에 통합:

```
. durability: 시간이 지나도 유효할수록 높음 (날씨·일시적 감정 → 낮음, 직업·가치관·반복 패턴 → 높음)
```

### `LlmMemoryAnalysis` 인터페이스 (`memory.repository.ts`)

`temporary_penalty` 필드 제거.

### `computeScore` 공식

```ts
// before
0.25 * m.importance + 0.25 * m.durability + 0.20 * m.reusefulness +
0.20 * confirmedScore + 0.10 * recency -
0.10 * m.sensitivity - 0.30 * m.temporary_penalty

// after
0.25 * m.importance + 0.30 * m.durability + 0.20 * m.reusefulness +
0.20 * confirmedScore + 0.10 * recency -
0.10 * m.sensitivity
```

---

## 2. LLM 출력 구조 변경 — 문장별 점수

`contents: string[]` → `contents: { text: string; importance: number; durability: number; reusefulness: number; sensitivity: number; explicit_signal: number; llm_confidence_hint: number }[]`

프롬프트 3번 지침("추출 결과에 대해 점수를 매긴다")을 "각 content 문장마다 점수를 매긴다"로 변경. `associations`는 지금처럼 `contents`와 같은 인덱스로 대응.

---

## 3. DB 마이그레이션

`memory_content.memory_id` FK(1:N) 제거, 조인 테이블 `memory__memory_content`(N:M) 추가 (결정 C):

```prisma
model memory_content {
  id                  String                      @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  content             String                      @db.Text
  importance          Float                       @default(0)
  durability          Float                       @default(0)
  reusefulness        Float                       @default(0)
  sensitivity         Float                       @default(0)
  explicit_signal     Float                       @default(0)
  llm_confidence_hint Float                       @default(0)
  repetition_count    Int                         @default(0)
  confirmed_score     Float                       @default(0)
  score               Float                       @default(0)
  embedding           Unsupported("vector(768)")?
  last_referenced_at  DateTime?                   @db.Timestamptz
  scored_at           DateTime?                   @db.Timestamptz
  created_at          DateTime                    @default(now()) @db.Timestamptz

  memory_versions memory__memory_content[]
  messages        memory_content__message[]
}

model memory__memory_content {
  memory_id         String @db.Uuid
  memory_content_id String @db.Uuid
  seq               Int    @default(0)

  memory         memory         @relation(fields: [memory_id], references: [id])
  memory_content memory_content @relation(fields: [memory_content_id], references: [id])

  @@id([memory_id, memory_content_id])
}

model memory {
  // score/sensitivity/importance/durability/reusefulness/explicit_signal/
  // repetition_strength/llm_confidence_hint/confirmed_score/temporary_penalty/embedding 컬럼 제거
  // content(join된 문자열) 컬럼도 제거 — 모든 조회를 memory_content join으로 통일하기로 결정
}
```

`seq`는 `memory_content` 컬럼이 아니라 **조인 테이블(`memory__memory_content`) 컬럼으로 이동** — "몇 번째냐"는 content 자체 속성이 아니라 "특정 memory 버전 안에서 몇 번째냐"이므로 관계에 붙는 게 맞음. `memory_id` 컬럼이 `memory_content`에서 아예 없어지므로, 지금 `memory_id`를 직접 세팅하던 모든 곳(`saveMemory`(4번, 반영됨), `updateKnowledgeMemory`, `importKnowledgeMemory`, `saveMainMemory` — 전부 `memory.repository.ts`)이 `memory_content.create` + `memory__memory_content.create`(seq 포함) 두 단계로 바뀌어야 함.

main 타입 memory(main memory)도 이제 구조적으로 N:M 테이블을 거쳐야 함(다른 방법이 없음) — 다만 지금처럼 버전마다 content를 통째로 새로 만드는 동작 자체는 그대로 유지(리팩토링은 이번 스펙 범위 아님). `seq`가 조인 테이블로 옮겨가면서, 나중에 main memory 편집(줄 삭제/재배치)을 버전 재생성 없이 해당 조인 row만 UPDATE/DELETE하는 방식으로 바꾸는 것도 구조적으로 가능해짐 — 그 실제 구현 전환은 여전히 이번 스펙 범위 아님(`todo.md` 참고했던 항목은 이 구조 변경으로 막혀있던 게 아니라 별개의 구현 선택 문제라 그대로 둠).

`delete_memory_version.sql`도 컬럼 제거로 인해 수정 필수(N:M 반영):

```sql
CREATE OR REPLACE FUNCTION delete_memory_version(p_memory_id uuid)
RETURNS void AS $$
DECLARE
  v_parent_id uuid;
BEGIN
  SELECT parent_memory_id INTO v_parent_id FROM memory WHERE id = p_memory_id;

  DELETE FROM memory__keyword WHERE memory_id = p_memory_id;

  -- 이 버전에서만 쓰이던(다른 버전 조인이 하나도 안 남는) content만 실제 삭제
  DELETE FROM memory_content_message WHERE memory_content_id IN (
    SELECT mmc.memory_content_id FROM memory__memory_content mmc
    WHERE mmc.memory_id = p_memory_id
      AND NOT EXISTS (
        SELECT 1 FROM memory__memory_content other
        WHERE other.memory_content_id = mmc.memory_content_id AND other.memory_id <> p_memory_id
      )
  );
  DELETE FROM memory_content WHERE id IN (
    SELECT mmc.memory_content_id FROM memory__memory_content mmc
    WHERE mmc.memory_id = p_memory_id
      AND NOT EXISTS (
        SELECT 1 FROM memory__memory_content other
        WHERE other.memory_content_id = mmc.memory_content_id AND other.memory_id <> p_memory_id
      )
  );
  DELETE FROM memory__memory_content WHERE memory_id = p_memory_id;

  IF v_parent_id IS NOT NULL THEN
    UPDATE memory SET is_active = true, deactivated_at = NULL WHERE id = v_parent_id;
  END IF;

  DELETE FROM memory WHERE id = p_memory_id;
END;
$$ LANGUAGE plpgsql;
```

---

## 4. `saveMemory` — 기존 content 조인 + 신규 insert

의사코드 (N:M 반영, 복사/재배정 없음):

```ts
async saveMemory(tx, userId, {messageIds, centroid, analysis, existingMemory}) {
  const newMemory = await tx.memory.create({ /* version+1, parent_memory_id 등 기존 그대로 */ });

  // 1. 기존 content 중 forgetting 조건(score/staleDays) 통과한 것만 새 버전과 조인
  if (existingMemory) {
    const scoreThreshold = Number(this.config.get('FORGETTING_SCORE_THRESHOLD', 0.2));
    const staleDays = Number(this.config.get('FORGETTING_STALE_DAYS', 60));
    const prevJoins = await tx.memory__memory_content.findMany({
      where: { memory_id: existingMemory.id },
      include: { memory_content: true },
    });
    // LLM이 이미 "기존 기억 최대한 유지, 중복 추가 안 함" 지침에 따라 새 문장만 냈다고 신뢰 —
    // score 낮고 오래 안 쓰인 것(=findForgettingCandidates와 동일 조건)만 여기서 걸러짐
    const surviving = prevJoins.filter(j => {
      const c = j.memory_content;
      const isStale = Date.now() - (c.last_referenced_at ?? c.created_at).getTime() > staleDays * 86400_000;
      return !(c.score < scoreThreshold && isStale);
    });
    await tx.memory__memory_content.createMany({
      data: surviving.map(j => ({ memory_id: newMemory.id, memory_content_id: j.memory_content_id, seq: j.seq })),
    });
  }

  // 2. 신규 문장만 insert (점수 계산 후) + 새 버전과 조인
  for (const [i, c] of analysis.contents.entries()) {
    const {confirmedScore, score} = computeScore({...c, repetition_count: 0, ...}, recencyDecayFactor);
    const mc = await tx.memory_content.create({ data: { content: c.text, ...점수들, score, confirmed_score: confirmedScore, embedding: contentEmbeddings[i] } });
    await tx.memory__memory_content.create({ data: { memory_id: newMemory.id, memory_content_id: mc.id } });
    // memory_content__message insert (associations[i])
  }
}
```

---

## 5. 재언급(repetition) 감지 — embedding 검색 기반 count

기존 `updateRepetitionStrength`(전체 active memory를 JS로 끌어와 cosine loop)를 pgvector 검색으로 교체:

```ts
async incrementMentionCount(tx, userId, contentEmbeddings: number[][], excludeMemoryIds: string[]) {
  const threshold = Number(this.config.get('REPETITION_SIMILARITY_THRESHOLD', 0.6));
  for (const emb of contentEmbeddings) {
    const matched = await tx.$queryRaw<{ id: string }[]>`
      SELECT mc.id
      FROM memory_content mc
      JOIN memory__memory_content mmc ON mmc.memory_content_id = mc.id
      JOIN memory m ON m.id = mmc.memory_id
      WHERE m.user_id = ${userId}::uuid AND m.is_active = true AND m.deleted_at IS NULL
        AND m.id <> ALL(${excludeMemoryIds}::uuid[])
        AND (1 - (mc.embedding <=> ${`[${emb.join(',')}]`}::vector)) >= ${threshold}
      ORDER BY mc.embedding <=> ${`[${emb.join(',')}]`}::vector
      LIMIT 1
    `;
    if (matched.length > 0) {
      await tx.memory_content.update({
        where: { id: matched[0].id },
        data: { repetition_count: { increment: 1 }, last_referenced_at: new Date() },
      });
      // score 재계산 (아래 정규화 공식으로 confirmed_score 재산출)
    }
  }
}
```

`repetition_strength`(0~1 연속값, growthRate로 증가) 대신 `repetition_count`(정수, 감쇠 없이 계속 누적)로 저장. `computeScore`에서 쓰던 `repetition_strength` 항은 topN 공식과 같은 스타일로 `log`를 써서 0~1로 정규화:

```ts
const repetitionNormalized = Math.min(1, Math.log2(repetition_count + 1) / Math.log2(REPETITION_NORM_CAP + 1));
```

`REPETITION_NORM_CAP`(몇 회 언급되면 1.0에 도달할지)은 **임의 선택 — 근거 없음, 일단 10으로 둠**. count 자체는 감쇠 안 시키고(계속 누적), 시간 경과 반영은 기존처럼 `last_referenced_at` 기반 recency 항이 따로 처리.

---

## 6. 승격(promotion) — content 단위

```ts
async findPromotedContents(userId: string, scoreThreshold: number, sensitivityThreshold: number, topN: number) {
  const ranked = await tx.memory_content.findMany({
    where: {
      memory_versions: { some: { memory: { user_id: userId, type: 'knowledge', is_active: true, deleted_at: null, is_pinned: false } } },
      score: { gt: scoreThreshold }, sensitivity: { lte: sensitivityThreshold },
    },
    orderBy: { score: 'desc' },
    take: topN,
    select: { content: true },
  });

  const pinned = await tx.memory_content.findMany({
    where: { memory_versions: { some: { memory: { user_id: userId, type: 'knowledge', is_active: true, deleted_at: null, is_pinned: true } } } },
    select: { content: true },
  });

  return [...ranked, ...pinned];
}
```

`scheduler.service.ts:updateMainMemory`에서 `promoted.map(m => m.summary)` → `promoted.map(c => c.content)`로 변경. `topN`은 결정 E대로 기존 memory 기준 공식 결과값 `* 5`로 둠 (`todo.md`에 재검토 항목 기록).

---

## 7. 망각(forgetting) — content 단위, 삭제 아니라 관계 제외

결정 F: 삭제/플래그 세팅 없이, forgotten content는 새 memory 버전을 만들 때 관계(조인 row)만 안 만듦. `ForgettingScheduler`는 채팅이 뜸해서 자연스러운 `saveMemory` 호출이 안 생기는 유저도 시간 지나면 실제로 반영되도록, **새 문장 없이 carry만 하는 `saveMemory` 호출**을 대상 memory에 대해 트리거함.

```ts
async findMemoriesWithForgettingCandidates(scoreThreshold: number, staleDays: number) {
  return this.prisma.$queryRaw<{ memory_id: string; user_id: string }[]>`
    SELECT DISTINCT m.id AS memory_id, m.user_id
    FROM memory m
    JOIN memory__memory_content mmc ON mmc.memory_id = m.id
    JOIN memory_content mc ON mc.id = mmc.memory_content_id
    WHERE m.type = 'knowledge' AND m.is_active = true AND m.deleted_at IS NULL AND m.is_pinned = false
      AND mc.score < ${scoreThreshold}
      AND COALESCE(mc.last_referenced_at, mc.created_at) < NOW() - (${staleDays} || ' days')::interval
  `;
}
```

`ForgettingScheduler.applyForgetting`: 위 쿼리로 forgetting candidate를 가진 활성 memory 목록을 찾고, 각각에 대해 `memoryRepo.saveMemory(tx, user_id, { messageIds: [], analysis: { contents: [], associations: [] }, existingMemory })`처럼 **새 content 없이** 호출 — carry 단계(4번)가 score/staleDays 필터를 적용해서 forgotten된 것만 빠진 새 버전을 만듦. `saveMemory`가 `messageIds: []`(신규 근거 메시지 없음) 케이스를 그냥 통과시키는지 확인 필요 — `markProceededTx`/embedding centroid 재계산 등 "새 메시지 있음"을 전제로 한 부분은 스킵하도록 가드 추가해야 할 수 있음(구현 시 확인). "새 버전에 조인된 content가 0개면 memory도 soft delete"(결정 F)는 이 carry 결과 그대로 적용됨. 배치 주기(cron)는 기존 그대로.

실제 `memory_content` row 자체의 물리 삭제(공간 확보)는 이번 스펙 범위 아님 — `todo.md`에 후속 항목으로 기록.

---

## 8. Decay — content 단위로 이전

```ts
async applyDecay() {
  const recencyDecayFactor = Number(this.config.get('RECENCY_DECAY_FACTOR', 30));
  const contents = await this.prisma.memory_content.findMany({
    where: {
      memory_versions: { some: { memory: { type: 'knowledge', is_active: true, deleted_at: null } } },
    },
  });
  for (const c of contents) {
    const { confirmedScore, score } = computeScore(c, recencyDecayFactor);
    await this.prisma.memory_content.update({
      where: { id: c.id },
      data: { confirmed_score: confirmedScore, score, scored_at: new Date() },
    });
  }
}
```

기존 `repetition_strength *= 0.995` 감쇠 항 제거(count는 감쇠 안 함, 결정 5번). recency(시간 경과) 부분만 재계산해서 `score`/`confirmed_score`/`scored_at` 갱신 — `DecayScheduler`(`decay.scheduler.ts`, 매일 00:00 UTC) 자체는 그대로 두고 `applyDecay` 내부 대상만 `memory` → `memory_content`로 교체.

---

## 미해결 (feedback 필요)

없음 — 이번 feedback으로 전부 결정됨 (C/D: N:M 전환, E: topN 배수 임시값 + todo, 5번: repetition_count 정규화 공식, 3번: memory.content 컬럼 삭제, H: TOP_K→TOP_N 네이밍).
