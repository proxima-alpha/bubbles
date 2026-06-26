# Feed-003: message_content 테이블 추가 + message.summary 제거

## 목적

`message.summary`를 문장 단위로 쪼개 각각의 embedding과 함께 `message_content`에 저장.
이중 저장을 피하기 위해 `message.summary` 컬럼은 제거하고, 전문이 필요하면 `message_content`를 join해 재조합한다.
배치 미처리 여부는 `message_content` 존재 여부로 판별 (별도 boolean 플래그 없음).

---

## Task 1 — DB 마이그레이션

### 신규 테이블: `message_content`

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | `uuid` PK | |
| `message_id` | `uuid` FK → `message.id` | |
| `seq` | `int` | 문장 순서 (0-based) |
| `content` | `text` | 문장 단위 텍스트 |
| `embedding` | `vector(768)` | content embedding |
| `created_at` | `timestamptz` | |

### Prisma 모델

```prisma
model message_content {
  id         String                      @id @default(uuid()) @db.Uuid
  message_id String                      @db.Uuid
  seq        Int
  content    String                      @db.Text
  embedding  Unsupported("vector(768)")?
  created_at DateTime                    @default(now()) @db.Timestamptz

  message message @relation(fields: [message_id], references: [id])

  @@index([message_id, seq])
}
```

`message` 모델 변경:
- `summary String? @db.Text` 제거
- `message_contents message_content[]` relation 추가

---

## Task 2 — 코드 변경

### 영향 범위

- `memory.repository.ts` — `MessageForBatch.summary` 제거, SQL에서 `summary` 제거. `runAssociationMapping`용 쿼리 추가
- `scheduler.service.ts` — `runAssociationMapping` 로직을 DB 쿼리로 교체
- `chat.service.ts` — assistant message 저장 시 summary 문장 분리 + embedding → `message_content` insert 추가
  > **메모**: `message_content` 생성 로직은 추후 스케줄러로 이전 예정

### `runAssociationMapping` 쿼리

content embedding 배열을 `unnest`로 넘겨 한 번에 처리. 그룹 내 메시지는 `message_id = ANY(...)` 로 필터링.

```sql
WITH query_embeddings AS (
  SELECT
    ordinality - 1             AS content_idx,
    embedding::vector(768)     AS query_embedding
  FROM unnest(:content_embeddings::vector(768)[]) WITH ORDINALITY AS t(embedding, ordinality)
),
scored AS (
  SELECT
    qe.content_idx,
    mc.message_id,
    mc.id        AS chunk_id,
    mc.content   AS chunk_text,
    1 - (mc.embedding <=> qe.query_embedding) AS similarity,
    ROW_NUMBER() OVER (
      PARTITION BY qe.content_idx, mc.message_id
      ORDER BY mc.embedding <=> qe.query_embedding
    ) AS rn
  FROM query_embeddings qe
  CROSS JOIN message_content mc
  WHERE mc.message_id = ANY(:message_ids)
),
top2 AS (
  SELECT
    content_idx,
    message_id,
    MAX(CASE WHEN rn = 1 THEN similarity END) AS top1,
    MAX(CASE WHEN rn = 2 THEN similarity END) AS top2
  FROM scored
  WHERE rn <= 2
  GROUP BY content_idx, message_id
)
SELECT
  content_idx,
  message_id,
  CASE
    WHEN top2 IS NULL THEN top1
    ELSE top1 * 0.7 + top2 * 0.3
  END AS final_score
FROM top2
WHERE
  CASE
    WHEN top2 IS NULL THEN top1
    ELSE top1 * 0.7 + top2 * 0.3
  END >= 0.75
ORDER BY content_idx, final_score DESC;
```

결과를 `content_idx` 기준으로 그룹핑해 `associations[i]` 배열로 조립.

### `MessageForBatch` 변경

```typescript
// summary 필드 제거, contents 불필요 (DB에서 직접 조회)
interface MessageForBatch {
  id: string;
  role: string;
  provider: string | null;
  content: string;
  terms: string[];
  embedding: number[];
}
```
