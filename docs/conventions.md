# conventions.md — Bubbles 상세 컨벤션

DB 스키마, API 설계 등 세부 컨벤션 레퍼런스. 해당 작업을 할 때만 참고.
워크플로우/의사결정 원칙은 `CLAUDE.md` 참고.

---

## Repository 패턴

- **DB에 직접 접근하는 함수는 모두 Repository에** — Service에서 `this.prisma.*`를 직접 호출하지 않는다
- Repository 메서드는 트랜잭션 참여가 필요한 경우 첫 번째 인자로 `tx: Prisma.TransactionClient`를 받는다
- 트랜잭션 경계(`prisma.$transaction(...)`)는 Service가 소유한다 — 무엇을 묶을지는 비즈니스 로직의 판단
- `tx`를 받은 Repository 메서드는 내부에서 `this.prisma` 대신 `tx`를 사용한다

```typescript
// Repository
async saveMemory(tx: Prisma.TransactionClient, userId: string, args: SaveArgs) {
  await tx.memory.create({ ... });
}

// Service — 트랜잭션 경계 소유
await this.prisma.$transaction(async (tx) => {
  await this.memoryRepo.saveMemory(tx, userId, args);
  await this.memoryRepo.updateStats(tx, userId, ...);
});
```

## 테이블 컬럼 선언 순서

PK → ID FK → Code FK → 일반 필드 → `is_xxx` boolean → `xxx_at` (추가) → `created_at` / `updated_at` / `deleted_at`

## Junction 테이블

- 명명: `aaa__bbb` (더블 언더스코어로 두 테이블명 연결)

## 공통코드 (common_code_category / common_code)

- enum 대신 공통코드 사용. 분류는 `common_code_category`, 코드값은 `common_code`로 분리
- `common_code` PK: composite `(category_code, code)`. `category_code` FK → `common_code_category.code`
- 컬럼 명명 규칙: `[테이블명_]변수명` 형식. 테이블에 `bbb`, `bbb_category` 쌍으로 추가. `_code` 접미사 생략
- FK: `aaa(bbb_category, bbb)` → `common_code(category_code, code)`
- "aaa 테이블에 공통코드 c, d 값을 가지는 bbb 추가" 요청 시:
  1. aaa 테이블에 `bbb_category varchar`, `bbb varchar` 컬럼 추가
  2. `common_code_category`에 `'bbb'` 시드 추가
  3. `common_code`에 `('bbb', 'c')`, `('bbb', 'd')` 시드 추가

## 공통코드 API 응답 규칙

- `_category` 필드는 API response에 포함하지 않음
- 공통코드 필드는 `common_code` 테이블을 join해서 `{ code, name }` 형태의 `CodeDto`로 반환
- 예: `{ role: { code: "assistant", name: "어시스턴트" }, provider: { code: "claude", name: "Claude" }, model: { code: "claude-opus-4-7", name: "Claude Opus 4.7" } }`
- `CodeDto`는 `src/common/dto/code.dto.ts`에 정의: `{ code: string; name: string }`

## REST API 규칙

CRUD는 `/xxxx` 경로에서 HTTP method로 구분:

| Method | 경로 | 용도 |
|--------|------|------|
| `GET` | `/xxxx` | 단순 목록 조회 (페이지/정렬만, 필터 없음) |
| `POST` | `/xxxx` | 생성 |
| `GET` | `/xxxx/:id` | 단건 조회 |
| `PUT` | `/xxxx/:id` | 수정 |
| `DELETE` | `/xxxx/:id` | 삭제 |
| `POST` | `/xxxx/search` | 필터 포함 목록 조회 (body에 JSON) |
| `GET` | `/xxxx/count` | 단순 count |
| `POST` | `/xxxx/search/count` | 필터 포함 count (body에 JSON) |

## 페이지네이션 / 필터

`GET /xxxx`는 query param, `POST /xxxx/search`는 body로 동일한 파라미터 전달:

- `page` — 페이지 번호 (1-based). 기본값 1
- `perPage` — 페이지당 항목 수. 기본값 1000
- `sortBy` — 정렬 필드 (단일). 방향은 `sort`로 지정
- `sort` — 정렬 방향 (`ASC` / `DESC`). 기본값 `DESC`
- `sorts` — 다중 정렬 시 사용. `sortBy`/`sort`보다 우선. 예: `[{ "field": "createdAt", "direction": "DESC" }, { "field": "name", "direction": "ASC" }]`
- `filters` — (`POST /search` 전용) 배열. 각 요소는 `{ operator, field, value }` 또는 `{ operator: "AND"|"OR", filters: [...] }` (중첩 가능)

지원 operator: `EQUALS`, `NOT_EQUALS`, `LIKE`, `LESS_THAN`, `LESS_THAN_OR_EQUALS`, `GREATER_THAN`, `GREATER_THAN_OR_EQUALS`, `IS_NULL`, `IS_NOT_NULL`, `IN`

- `EQUALS`의 `field`는 콤마로 여러 필드 지정 가능 → OR 매칭. `value`가 빈 문자열이면 IS NULL 처리
- `IN`의 `value`는 배열 (예: `"value": ["a","b","c"]`)
- 기본 정렬 후순위: `id ASC` (id 필드 없으면 `code ASC`) 자동 추가
- 엔티티에 없는 필드는 400 반환
