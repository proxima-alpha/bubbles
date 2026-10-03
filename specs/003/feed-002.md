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
- [ ] (9) `memory_content.memory_id` 제거로 깨지는 기존 함수 이전(전부 `memory.repository.ts`):
  - `getKnowledgeList`(370행)/`getKnowledgeByKeyword`(397행)/`findKnowledgeMemory`(407행)/`findMemoryHistory`(428행) — 전부 `include: {contents: true}`(1:N 관계) 사용 중, N:M 전환되면 이 관계 자체가 없어져서 그대로 깨짐. `memory__memory_content` 조인 거쳐서 `memory_content` 가져오는 `include`/쿼리로 변경 필요 — 조회 API라 마이그레이션 직후 가장 먼저 부딪히는 곳, `deleteKnowledgeMemory`보다 우선순위 높게 처리
  - `importKnowledgeMemory`, `deleteKnowledgeMemory` — `memory_id`로 직접 create/delete하던 부분을 "조인 테이블(`memory__memory_content`) 조회 → `memory_content` 처리" 패턴으로 변경
  - `updateKnowledgeMemory` — 지금처럼 기존 활성 버전 비활성화 + 새 memory row 생성(버전업, history 보존)은 그대로 유지. content 처리만 결정 K대로 문장별 `id` 있고 내용 같으면 기존 row 재사용/`id` 있고 내용 다르면 새 row 생성/`id` 없으면 신규 생성/기존에 있었는데 요청에 없으면 새 버전 조인에서만 제거하는 방식으로 다시 작성
  - `saveMainMemory` — 기존에도 carry 없이 매번 전체 재생성하므로 조회 단계는 필요 없음, `memory_content.create` + `memory__memory_content.create`(seq 포함) 두 단계로 바뀌기만 하면 됨
  - `updateKnowledgeMemory`/`importKnowledgeMemory`가 carry하던 `memory.temporary_penalty`/`llm_confidence_hint`/`confirmed_score` 등 삭제 컬럼 참조도 같이 제거
- [ ] (10) `analyzeConversation`에서 "기존 기억" 컨텍스트 제거 — `scheduler.service.ts:129`의 `group.existingMemory?.content ?? undefined`를 항상 `undefined`로(재구성 안 함). LLM은 이제 새 메시지만 보고 분석(결정 J 참고). `existingContent` 파라미터가 항상 미사용되므로 `analyzeConversation` 시그니처/prompt 5번 지침 블록 정리는 선택 사항. `ExchangeGroup`/`existingMemory` 타입의 `content` 필드도 같이 정리

---

## 결정 사항 (초안 — feedback 필요)

| # | 항목 | 제안                                                                                                                                                                                                                                                                                                                                                                                                  |
|---|------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| A | `temporary_penalty` 통합 방식 | 필드는 삭제하고 `durability` 하나로 흡수 (프롬프트 정의 자체가 서로 반대 방향 동어반복이었음). score 공식의 `0.25*durability - 0.30*temporary_penalty` 두 항을 `0.30*durability` 하나로 대체 — penalty 쪽이 원래 더 세게 반영됐던 비대칭(0.30 > 0.25)을 유지하려고 0.30 채택. **가중치 숫자 자체는 임의 선택 — 근거 없음**                                                                                                                                                             |
| B | 버전 생성 단위 | 새 버전은 **새 문장이 생겼을 때(chat 배치) 또는 forgotten content가 있을 때(F, ForgettingScheduler)** 생성 — 둘 다 아니면 버전 그대로 유지. `saveMemory` 구현은 이 조건으로 게이팅해야 함(무조건 새 버전 생성 아님). 새 버전 결과 조인된 content가 0개면, 그 새 버전 row 하나만 비활성 처리(F 참고 — lineage 전체나 content는 안 건드림) — 안 건드린 memory는 버전 그대로 (지금 구조도 group→existingMemory 1:1이라 그룹 자체는 이미 이렇게 동작 중, 이번 스펙은 "새 버전의 content 구성 방식"만 바꾸는 것)                                                                                                                                                        |
| C | `memory`↔`memory_content` 관계 및 새 버전의 content 구성 | 기존 1:N(`memory_content.memory_id`)을 **N:M**으로 변경 — 조인 테이블 `memory__memory_content(memory_id, memory_content_id)` 추가. 새 버전 row 생성 시, 기존 활성(F 참고) `memory_content`는 복사/재배정 없이 **조인 row만 새 버전에 대해 추가**(content 자체는 손 안 댐, id·score·embedding·repetition_count 등 그대로). 신규 문장만 LLM 분석 결과로 새 `memory_content` insert 후 조인. 옛 버전의 조인 row도 그대로 남기 때문에 버전 히스토리가 안 깨짐. **"중복 판단"은 LLM이 안 함(J 참고)** — LLM은 새 메시지만 보고 판단, 같은 memory 안에서의 문장 중복 방지는 이번 스펙에 없음(알려진 한계, `todo.md`)                          |
| D | carry된 문장의 재언급 count | (C가 N:M으로 바뀌면서 자동 해소됨) 복사/재배정을 안 하므로 애초에 같은 row — count는 그대로 유지됨을 신경 쓸 필요 없음                                                                                                                                                                                                                                                                                                                        |
| E | 승격(promotion) 대상 | 지금은 `memory.summary`를 승격 재료로 씀 (`scheduler.service.ts:247` `newKnowledges = promoted.map(m => m.summary)`). content 단위로 내리면서 **개별 문장(`memory_content.content`)을 직접 승격 재료로 사용**하도록 변경 — summary 대신 실제 고득점 문장들을 `synthesizeMainMemory`에 넘김. topN은 기존에는 memory 개수로 해두었지만(`Math.max(3, log2(totalActiveMemory+1))`), memory_content 단위로 바꾸면서 임의로 기존 공식에 `*5`를 곱해두었음 — 실질적인 전략은 추후에 재조정 필요(`todo.md` 기록)                                          |
| F | 망각(forgetting)의 의미 | **별도 컬럼 없이, `memory__memory_content` 관계 존재 여부 자체로 "활성 여부"를 표현.** memory 버전을 이미 전부 이력으로 남기고 있어서, 지금 당장 공간 확보용 삭제는 필요 없음 — 실제 row 삭제(공간 확보)는 나중 문제로 미룸(`todo.md`). 판정(score/staleDays)에 쓰는 필터 로직은 `saveMemory`의 carry 단계(4번)와 동일한 걸 재사용. **`ForgettingScheduler`는 유지** — 매일 대상 memory를 훑어서 forgetting candidate가 있으면, 새 메시지가 없어도 **"새 문장 없이 carry만 하는 saveMemory 호출"**로 새 버전을 만들어 forgotten content의 관계를 새 버전에서 빼버림(그래야 채팅이 뜸한 유저도 시간 지나면 실제로 active 목록에서 빠짐 — 채팅 트리거만 기다리지 않음). 과거 버전의 관계는 안 건드림(히스토리 보존). 이 결과로 만들어진 새 버전에 조인된 content가 0개면, **그 새 버전 memory row 하나만** 비활성 처리(`is_active: false` + `deleted_at: now()`) — Spec 3의 `deleteKnowledgeMemory`(유저 삭제 API, lineage 전체 대상 + content hard delete + message `root_memory_id` 리셋까지 하는 무거운 삭제)는 호출 안 함. 과거 버전들의 content/조인은 그대로 두고, 물리 삭제 없음(hard delete 아님). **부모 버전(`parent_memory_id`) 재활성화 안 함** — `delete_memory_version.sql`(Section 3)의 "활성 버전 삭제되면 부모를 `is_active: true`로 되돌리는" 패턴과는 다른 케이스: 그 패턴은 버전 row 자체를 삭제(lineage 삭제)할 때고, 여기는 새로 만든 빈 버전만 비활성화하는 거라 그 함수를 호출하지 않음 — 부모는 애초에 건드릴 이유가 없음(건드리면 방금 걸러낸 문장이 그대로 조인된 부모가 도로 active로 부활해서 안 됨) |
| G | keyword/summary | 이번 스펙 범위 아님 — 계속 memory(그룹) 단위 유지. summary는 그룹 전체 요약 표시용으로 남기고, 승격 로직만 content 기반으로 바꿈(E 참고)                                                                                                                                                                                                                                                                                                        |
| H | `TOP_K` → `TOP_N` 네이밍 통일 | 이번 스펙에서 promotion topN을 새로 도입하면서, 기존 RAG 검색 쪽 `TOP_K` 네이밍과 안 맞음 — `TOP_N`으로 통일. 대상: `.env`의 `RAG_TOP_K` → `RAG_TOP_N`, `memory.repository.ts:337`/`memory.service.ts:18` `getTopKnowledge(..., topK)` 파라미터명 → `topN`. `specs/002/spec.md`는 이미 적용된 과거 기록이라 안 건드림                                                                                                                                              |
| I | Decay 대상 이전 | `applyDecay`(`memory.repository.ts:630`)가 아직 `memory` 테이블 기준으로 돎 — 점수 필드가 `memory_content`로 이전되므로 이것도 `memory_content`(활성 memory에 조인된 것) 기준으로 바꿔야 함. `repetition_strength *= 0.995` 감쇠 로직은 제거(count는 감쇠 안 함, 5번 참고), recency 기반 score만 재계산해서 `score`/`confirmed_score`/`scored_at` 갱신                                                                                                                                                    |
| J | `analyzeConversation`의 "기존 기억" 컨텍스트 제거 | `existingMemory.content`를 프롬프트에 안 넘김 — LLM은 **새 메시지만** 보고 분석(`scheduler.service.ts:129`를 항상 `existingContent: undefined`로 호출). 부작용: 지금 prompt 5번 지침("기존 기억 최대한 유지, 중복 내용은 추가 안 함")이 이걸로 동작했는데, 이제 그 지침이 아예 안 붙음 — **같은 memory 그룹 안에서 이미 있는 문장을 LLM이 다시 뽑아내도 막을 방법이 없어짐**(재언급 감지, 5번 섹션은 지금 배치에서 막 만든/건드린 memory는 `excludeMemoryIds`로 제외하기 때문에 같은 memory 내부 중복은 안 잡음, 다른 memory와의 교차 반복만 잡음). 알려진 한계로 `todo.md`에 기록, 필요해지면 재검토 |
| K | `updateKnowledgeMemory`(유저 수동 편집)의 문장 단위 처리 | 조회 응답(`GET /memory/knowledge/:id`)에 문장마다 `memory_content.id`를 같이 내려주고, 수정 요청(`PUT /memory/knowledge/:id`)도 `contents: { id?: string; text: string }[]`로 받음. **지금 코드처럼 항상 새 memory 버전을 생성**(기존 활성 버전 비활성화 + 새 memory row 생성) — 수동 편집도 하나의 변경 이벤트이므로 history 보존(`plan.md:41`). 그 안에서 content 처리: `id` 있고 `text`가 기존 row와 동일 → 그 row 그대로 재사용(새 버전에 조인만). `id` 있고 `text`가 다름(수정) → **새 `memory_content` row 생성**(embedding 새로 생성, `score`/`repetition_count`는 옛 row 값 그대로 복사해서 재계산 없이 넘김). `last_referenced_at`/`scored_at`은 복사하지 않고 비워둠(null) — `computeScore`의 recency 계산(`memory.repository.ts:64`)이 `last_referenced_at ?? created_at`이라 null이면 새 row의 `created_at`(수정 시점)으로 떨어져서 자동으로 "가장 최근"으로 취급되고, `scored_at`은 다음 `DecayScheduler` 배치(8번, 매일)가 어차피 재계산해서 채우므로 즉시 채울 필요 없음. 새 버전은 이 새 row에 조인(옛 row는 과거 버전에만 남아 그대로 보존 — in-place UPDATE 없음). `id` 없는 항목은 새 `memory_content`로 생성. 기존에 조인돼 있던 문장인데 이번 요청에 그 `id`가 안 왔으면 새 버전 조인에서만 뺌(row 자체·과거 버전 조인은 안 건드림). → Decision C의 "과거 버전 히스토리 불변" 전제, 수동 편집에도 동일하게 유지됨(예외 없음) |

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

`LlmMemoryAnalysis`(`memory.repository.ts:16-28`)의 `importance`/`durability`/`reusefulness`/`sensitivity`/`explicit_signal`/`llm_confidence_hint` 필드는 전부 제거하고 `contents` 배열 안으로 옮김 — 이 필드들은 지금 `schema.prisma`의 `model memory`(현재 128-172행) 컬럼과 1:1로 대응돼서 그대로 저장되고 있는데, 결정 C대로 `memory` 테이블에서 `score`/`sensitivity`/`importance`/`durability`/`reusefulness`/`explicit_signal`/`repetition_strength`/`llm_confidence_hint`/`confirmed_score`/`temporary_penalty`/`embedding`/`content` 12개 컬럼을 실제로 DROP하는 마이그레이션이 나가야 하므로(3번), `LlmMemoryAnalysis` 인터페이스도 그 컬럼들을 채우던 필드를 그대로 남겨두면 안 됨.

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
  DELETE FROM memory_content__message WHERE memory_content_id IN (
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

`existingMemory`가 있으면 그 `memory__memory_content` 조인을 `memory_content` 포함해서 조회하고, 각 content의 `score`/`last_referenced_at`으로 forgetting 조건(`FORGETTING_SCORE_THRESHOLD`/`FORGETTING_STALE_DAYS`, F·7번과 동일 조건: score < threshold AND stale)을 통과 못한 것만 걸러낸 뒤, 나머지를 새 `memory_id`로 조인(`seq`도 그대로 carry, content 자체는 안 건드림). LLM이 새로 낸 문장(`analysis.contents`, 빈 배열이면 이 단계 없음)은 각각 `computeScore`로 점수 계산 후 `memory_content` insert하고 새 버전과 조인, 근거 메시지는 `memory_content__message`로 연결(기존과 동일). 결정 B: 위 두 단계 결과 새 버전의 조인 content id 집합이 기존 memory(해당 lineage 현재 활성 버전)의 content id 집합과 동일하면(순서 무관, carry 전부 survive, 신규 없음) 새 버전 생성 자체를 스킵 — 무조건 생성 아님. **스킵할 땐 기존 `existingMemory` 비활성화(`is_active: false`)도 같이 하지 않음** — 지금 코드가 "existingMemory 있으면 무조건 먼저 비활성화 후 새 버전 생성" 순서라서, 생성만 스킵하고 비활성화는 그대로 두면 그 memory 그룹이 활성 버전 없이 고아가 됨.

**`markProceededTx` 호출 위치 이전** — `memory.repository.ts:229`의 `await this.messageRepo.markProceededTx(tx, messageIds);`는 `saveMemory` 밖으로 뺀다. "메시지 처리 끝났다"고 마킹하는 건 `saveMemory`(memory 저장 책임)가 아니라 호출자 책임 — forgetting이 트리거하는 carry 전용 호출(`messageIds: []`)이 `saveMemory` 안에 이 부수효과를 그대로 딸고 오는 구조 자체가 문제. `scheduler.service.ts:148`의 `await this.memoryRepo.saveMemory(tx, userId, args)` 호출 직후 `await this.messageRepo.markProceededTx(tx, args.messageIds)`를 호출자가 직접 하도록 옮김. `ForgettingScheduler.applyForgetting`(7번)은 이 호출을 안 하므로 `saveMemory` 안에 있던 것과 달리 자동으로 안전함(별도 가드 불필요).

---

## 5. 재언급(repetition) 감지 — embedding 검색 기반 count

기존 `updateRepetitionStrength`(전체 active memory를 JS로 끌어와 cosine loop)를 pgvector 검색으로 교체 — 새 배치의 각 content embedding마다, `user_id`/`is_active`/`deleted_at IS NULL` 조건을 만족하는 memory에 조인된 `memory_content` 중 이번에 새로 만든 memory 자신(`excludeMemoryIds`)은 제외하고, cosine similarity(`1 - (embedding <=> ...)`)가 `REPETITION_SIMILARITY_THRESHOLD` 이상인 것 중 가장 유사한 1건을 pgvector로 검색 — 매칭되면 `repetition_count`를 증가시키고 `last_referenced_at`을 갱신. 실제 쿼리는 `/apply` 시 작성.

`repetition_strength`(0~1 연속값, growthRate로 증가) 대신 `repetition_count`(정수, 감쇠 없이 계속 누적)로 저장. `computeScore`는 `repetition_count`를 그대로 받아 내부에서 `Math.min(1, Math.log2(repetition_count + 1) / Math.log2(REPETITION_NORM_CAP + 1))`로 정규화(호출부는 별도 정규화 없이 raw count를 넘기면 됨 — 섹션 4/8의 `computeScore(c, ...)` 호출부는 수정 불필요). `REPETITION_NORM_CAP`은 **임의 선택 — 근거 없음, 일단 10**. count 자체는 감쇠 안 시킴. `score`/`confirmed_score` 반영은 즉시 하지 않고 다음 `DecayScheduler` 배치(8번) 때 재계산 — 재언급 직후 즉시 반영이 필요해지면 나중에 재검토.

---

## 6. 승격(promotion) — content 단위

`findPromotedMemories`를 `findPromotedContents(userId, scoreThreshold, sensitivityThreshold, topN)`로 교체 — `memory_content`를 `memory_versions`(조인) 통해 `user_id`/`type: 'knowledge'`/`is_active`/`is_pinned: false`인 것 중 `score > scoreThreshold AND sensitivity <= sensitivityThreshold`로 필터, `score desc`로 topN개 추출(`content`만 select). 별도로 `is_pinned: true`인 memory에 속한 content는 threshold 무관하게 전부 포함. 두 결과를 합쳐서 반환.

`scheduler.service.ts:updateMainMemory`에서 `promoted.map(m => m.summary)` → `promoted.map(c => c.content)`로 변경. `topN`은 결정 E대로 기존 memory 기준 공식 결과값 `* 5`로 둠 (`todo.md`에 재검토 항목 기록).

---

## 7. 망각(forgetting) — content 단위, 삭제 아니라 관계 제외

결정 F: 삭제/플래그 세팅 없이, forgotten content는 새 memory 버전을 만들 때 관계(조인 row)만 안 만듦. `ForgettingScheduler`는 채팅이 뜸해서 자연스러운 `saveMemory` 호출이 안 생기는 유저도 시간 지나면 실제로 반영되도록, **새 문장 없이 carry만 하는 `saveMemory` 호출**을 대상 memory에 대해 트리거함.

**스케줄 순서 — memorize 배치와 겹치지 않음**: `ForgettingScheduler`와 memorize 스케줄러(미처리 messages 기반 트리거)는 동시에 돌지 않음 — memorize 배치가 끝난 뒤에만 forgetting 배치가 실행되도록 순서 보장(둘 다 같은 memory lineage를 거의 동시에 비활성화+새 버전 생성하려는 레이스 방지). 구체적 동기화 방식(같은 cron 안에서 순차 호출/락 등)은 `/apply` 시 결정.

`ForgettingScheduler.applyForgetting`이 찾는 forgetting candidate 조건: `type='knowledge' AND is_active=true AND deleted_at IS NULL AND is_pinned=false`인 memory 중, 조인된 `memory_content`의 `score < FORGETTING_SCORE_THRESHOLD` AND `COALESCE(last_referenced_at, created_at)`가 `FORGETTING_STALE_DAYS`보다 오래된 것이 하나라도 있는 memory. 실제 쿼리는 `/apply` 시 작성.

candidate로 찾은 활성 memory 각각에 대해 `saveMemory`를 **새 content 없이**(`messageIds: []`, `analysis.contents: []`) 호출 — carry 단계(4번)가 score/staleDays 필터를 적용해서 forgotten된 것만 빠진 새 버전을 만듦. `centroid` UPDATE(`memory.repository.ts:191-195`)는 넘어온 `centroid` 값을 그대로 쓰므로, `ForgettingScheduler.applyForgetting`이 호출할 때 `centroid` 인자로 `existingMemory`의 기존 embedding 값을 그대로 넘기기만 하면 됨(재계산 없이). `markProceededTx`는 4번 결정대로 `saveMemory` 밖으로 옮겨졌으므로 `ForgettingScheduler`는 이 호출 자체를 안 함 — 별도 가드 불필요. 이 새 버전에 조인된 content가 0개면(결정 F) 그 새 버전 memory row만 비활성 처리됨(3번 참고). 배치 주기(cron)는 기존 그대로.

실제 `memory_content` row 자체의 물리 삭제(공간 확보)는 이번 스펙 범위 아님 — `todo.md`에 후속 항목으로 기록.

---

## 8. Decay — content 단위로 이전

`applyDecay` 대상을 `memory`(active, knowledge)에서 `memory_versions` 조인 통해 active knowledge memory에 걸린 `memory_content` 전체로 변경. 각 content마다 `computeScore`로 재계산 후 `score`/`confirmed_score`/`scored_at` 갱신. 기존 `repetition_strength *= 0.995` 감쇠 항은 제거(count는 감쇠 안 함, 결정 5번) — recency(시간 경과) 부분만 재계산. `DecayScheduler`(`decay.scheduler.ts`, 매일 00:00 UTC) 자체는 그대로, `applyDecay` 내부 대상만 교체.

---

## 미해결 (feedback 필요)

없음 — 이번 feedback으로 전부 결정됨 (C/D: N:M 전환, E: topN 배수 임시값 + todo, 5번: repetition_count 정규화 공식, 3번: memory.content 컬럼 삭제, H: TOP_K→TOP_N 네이밍).

audit 이후 2차 결정: K(`updateKnowledgeMemory`는 항상 새 버전 생성해 history 보존, 수정된 문장은 in-place UPDATE 없이 새 `memory_content` row로 생성), B/F("조인 0개 → soft delete"는 새 버전 row 하나만 비활성 처리, lineage/hard delete 아님, 부모 버전 재활성화 안 함), 2번(`markProceededTx` 호출을 `saveMemory`에서 호출자(`scheduler.service.ts:148`)로 이전 — forgetting 트리거 호출은 이 함수를 아예 안 부르게 됨. `centroid`는 호출부 `ForgettingScheduler.applyForgetting`이 `existingMemory`의 기존 embedding을 그대로 넘기기만 하면 됨), Task 9에 조회 함수 4개(`getKnowledgeList`/`getKnowledgeByKeyword`/`findKnowledgeMemory`/`findMemoryHistory`) 추가. 3차 audit 결정: Section 4의 "새 버전 조인이 이전 버전과 동일" 비교는 기존 memory(해당 lineage 현재 활성 버전)의 content id 집합 기준(순서 무관), `ForgettingScheduler`와 memorize 스케줄러는 동시 실행 금지 — memorize 배치 완료 후 forgetting 배치가 실행되도록 순서 보장(7번 참고). plan.md 점수 공식(42/47행) 동기화는 이번 스펙 적용 마지막 단계로 미룸(`todo.md`).
