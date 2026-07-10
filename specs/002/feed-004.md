# Feed-004: callLlmForAnalysis에 기존 메모리 원본 메시지 전달

## 목적

`callLlmForAnalysis`가 병합(merge) 대상 `existingMemory`의 컨텍스트로 `existingMemory.content`(이미 LLM이 추출한 문장 요약본)를 전달하고 있어, 병합이 반복될수록 정보 손실이 누적된다.
`existingMemory.id`를 통해 실제로 그 memory를 만든 원본 메시지를 역추적할 수 있으므로, 요약본 대신 원본 메시지를 전달한다.

무한정 누적 여부: `saveMemory`에서 새 `memory_content`는 **이번 그룹의 메시지에만** 연결되므로 (`findAssociations`가 현재 그룹의 `assistantMessages`만 대상), `existingMemory` 한 단계(직전 버전)에 연결된 메시지만 가져오면 되고 버전 체인을 계속 타고 올라갈 필요는 없다.

---

## Task 1 — `memory.repository.ts`

### `findMemoryMessages` 추가

`memory_content` → `memory_content__message` → `message` join으로 해당 memory에 실제로 연결된 원본 메시지 조회. 한 메시지가 여러 `memory_content`에 연결될 수 있으므로 중복 제거, `created_at` 순 정렬.

```typescript
async findMemoryMessages(memoryId: string): Promise<MessageForBatch[]> {
  return this.prisma.$queryRaw<MessageForBatch[]>`
    SELECT id, role, provider, content, terms FROM (
      SELECT DISTINCT m.id, m.role, m.provider, m.content, m.terms, m.created_at
      FROM memory_content mc
      JOIN memory_content__message mcm ON mcm.memory_content_id = mc.id
      JOIN message m ON m.id = mcm.message_id
      WHERE mc.memory_id = ${memoryId}::uuid
    ) t
    ORDER BY created_at ASC
  `;
}
```

### `findSimilarMemory` — `content` 제거

더 이상 쓰이지 않으므로 SELECT 및 반환 타입에서 `content` 제거.

```typescript
async findSimilarMemory(
  userId: string,
  vec: number[],
  threshold: number,
): Promise<{ id: string; version: number; root_memory_id: string | null } | null> {
  const rows = await this.prisma.$queryRaw<
    { id: string; version: number; root_memory_id: string | null; similarity: number }[]
  >`
    SELECT id, version, root_memory_id,
           (1 - (embedding <=> ${`[${vec.join(',')}]`}::vector)) AS similarity
    FROM memory
    WHERE user_id = ${userId}::uuid
      AND type = 'knowledge'
      AND is_active = true
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${`[${vec.join(',')}]`}::vector
    LIMIT 1
  `;

  if (rows.length === 0 || rows[0].similarity < threshold) return null;
  return rows[0];
}
```

---

## Task 2 — `scheduler.service.ts`

### `GroupArgs.existingMemory` — `content` 제거

```typescript
interface GroupArgs {
  messages: MessageForBatch[];
  memCentroid: number[];
  existingMemory: { id: string; version: number; root_memory_id: string | null } | null;
}
```

### `executeMemorization` — 병합된 그룹 단위로 원본 메시지 조회

`consolidateByTarget` 이후 최종 그룹 단위로, `existingMemory`가 있을 때만 `findMemoryMessages` 호출.

```typescript
const pendingSaves: SaveArgs[] = [];
for (const group of groups) {
  const existingMessages = group.existingMemory
    ? await this.memoryRepo.findMemoryMessages(group.existingMemory.id)
    : undefined;
  const analysis = await this.callLlmForAnalysis(userId, group.messages, existingMessages);
  if (analysis.contents.length > 0) {
    const associationMessages = existingMessages ? [...existingMessages, ...group.messages] : group.messages;
    const associations = await this.runAssociationMapping(analysis.contents, associationMessages);
    pendingSaves.push({...group, analysis: {...analysis, associations}});
  }
}
```

`runAssociationMapping`은 `analysis.contents`를 대상으로 근거 메시지를 찾는데, LLM이 `existingMessages`(기존 대화)에서 유래한 문장을 추출할 수도 있으므로 association 검색 대상 메시지에도 `existingMessages`를 포함해야 한다. 그렇지 않으면 해당 문장이 `saveMemory`의 `validPairs` 필터에서 근거 없음으로 걸러져 `memory_content`/`memory_content__message`가 안 만들어지고, 다음 병합 때 `findMemoryMessages`로 추적할 수 없게 되어 feed-004의 목적이 무력화된다.

### `callLlmForAnalysis` — `existingContent?: string | null` → `existingMessages?: MessageForBatch[]`

메시지 포맷 로직을 함수로 분리해 현재 메시지/기존 메시지 모두 동일한 포맷으로 직렬화.

```typescript
private async callLlmForAnalysis(
  userId: string,
  messages: MessageForBatch[],
  existingMessages?: MessageForBatch[],
): Promise<LlmMemoryAnalysis> {
  const formatMessages = (msgs: MessageForBatch[]) =>
    msgs.map(m => ({
      [m.role === 'user' ? 'user' : (m.provider ?? 'assistant')]: {
        text: m.content,
        message_id: m.role !== 'user' ? m.id : null,
      },
    }));

  const inputArray = formatMessages(messages);

  const contextSection = existingMessages && existingMessages.length > 0
    ? `[기존 메모리 원본 대화]\n${JSON.stringify(formatMessages(existingMessages), null, 2)}\n\n`
    : '';

  // 이하 프롬프트/스키마/LLM 호출은 기존과 동일, contextSection과 inputArray만 교체
  ...
}
```

---

## 영향 범위

- `memory.repository.ts` — `findMemoryMessages` 추가, `findSimilarMemory` 반환 타입 변경
- `scheduler.service.ts` — `GroupArgs.existingMemory` 타입 변경, `executeMemorization`/`callLlmForAnalysis` 변경

---

## 태스크

- [x] T1. `memory.repository.ts` — `findMemoryMessages` 추가, `findSimilarMemory`에서 `content` 제거
- [x] T2. `scheduler.service.ts` — `GroupArgs.existingMemory` 타입에서 `content` 제거
- [x] T3. `scheduler.service.ts` — `executeMemorization`에서 병합 그룹 단위로 `findMemoryMessages` 호출
- [x] T4. `scheduler.service.ts` — `callLlmForAnalysis`를 `existingMessages: MessageForBatch[]` 기반으로 변경
- [x] T5. `scheduler.service.ts` — `runAssociationMapping` 호출 시 association 검색 대상에 `existingMessages` 포함
