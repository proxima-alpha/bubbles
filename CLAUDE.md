# CLAUDE.md — Bubbles 프로젝트

Claude Code가 이 프로젝트에서 따라야 할 규칙과 컨텍스트.

---

## 프로젝트 개요

개인용 AI 채팅 웹앱. RAG 시스템으로 세션 간 기억을 유지하며, 토큰 절약을 위해 세션은 짧게 끊는다.
자세한 내용은 `plan.md` 참고.

---

## 기술 스택

- **Frontend**: Next.js 14 (App Router), Tailwind CSS, shadcn/ui, React Query, Axios
- **Backend**: NestJS (TypeScript)
- **LLM**: general LLM 연동 (Claude, GPT 등 스위칭 가능, 특정 제공사 종속 없음)
- **ORM**: Prisma
- **RAG**: pgvector (PostgreSQL 확장), Ollama (`nomic-embed-text`), 직접 구현
- **Infra**: Docker Compose
- **구조**: `apps/frontend`, `apps/backend` 단순 폴더 모노레포

---

## 코딩 규칙

### 일반
- 언어는 **TypeScript** (strict mode)
- 함수/변수명은 **camelCase**, 클래스는 **PascalCase**
- 파일명은 **kebab-case**
- 주석은 꼭 필요한 경우에만 — 코드가 자명하면 생략
- 새 컴포넌트/모듈 작성 전 `research.md` 확인 — 유사한 동작이 있으면 확장해서 사용

### Backend (NestJS)
- 기능 단위로 Module 분리 (ChatModule, MemoryModule, KeywordModule, ConfigModule)
- 역할 분리: Controller(라우팅) → Service(비즈니스 로직) → Repository(DB 접근)
- DTO는 `class-validator`로 유효성 검사
- 환경변수는 `@nestjs/config`로 관리, 하드코딩 금지

### Repository 패턴

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

### 테이블 컬럼 선언 순서

PK → ID FK → Code FK → 일반 필드 → `is_xxx` boolean → `xxx_at` (추가) → `created_at` / `updated_at` / `deleted_at`

### Junction 테이블
- 명명: `aaa__bbb` (더블 언더스코어로 두 테이블명 연결)

### 공통코드 (common_code_category / common_code)
- enum 대신 공통코드 사용. 분류는 `common_code_category`, 코드값은 `common_code`로 분리
- `common_code` PK: composite `(category_code, code)`. `category_code` FK → `common_code_category.code`
- 컬럼 명명 규칙: `[테이블명_]변수명` 형식. 테이블에 `bbb`, `bbb_category` 쌍으로 추가. `_code` 접미사 생략
- FK: `aaa(bbb_category, bbb)` → `common_code(category_code, code)`
- "aaa 테이블에 공통코드 c, d 값을 가지는 bbb 추가" 요청 시:
  1. aaa 테이블에 `bbb_category varchar`, `bbb varchar` 컬럼 추가
  2. `common_code_category`에 `'bbb'` 시드 추가
  3. `common_code`에 `('bbb', 'c')`, `('bbb', 'd')` 시드 추가

### 공통코드 API 응답 규칙

- `_category` 필드는 API response에 포함하지 않음
- 공통코드 필드는 `common_code` 테이블을 join해서 `{ code, name }` 형태의 `CodeDto`로 반환
- 예: `{ role: { code: "assistant", name: "어시스턴트" }, provider: { code: "claude", name: "Claude" }, model: { code: "claude-opus-4-7", name: "Claude Opus 4.7" } }`
- `CodeDto`는 `src/common/dto/code.dto.ts`에 정의: `{ code: string; name: string }`

### REST API 규칙

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

### 페이지네이션 / 필터

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

### Frontend (Next.js)
- Server Component 기본, 상태가 필요한 경우에만 Client Component
- API 호출은 Axios + React Query로 통일
- UI 컴포넌트는 shadcn/ui 먼저 확인 후 없으면 직접 작성

---

## 의사결정 기준

- **추가 비용 없는 선택 우선** — 유료 외부 서비스보다 로컬/오픈소스 선호
- **단순함 우선** — 토이프로젝트이므로 오버엔지니어링 금지
- **추상화는 실제로 필요할 때** — 미래를 위한 추상화 금지, 단 MemoryModule은 저장 단위 변경 가능성을 고려해 인터페이스로 설계
- 주문에 논리적 결함이 있거나 기술 선택에 트레이드오프가 있으면 먼저 제시하고 결정을 요청할 것

---

## 워크플로우

각 Spec은 아래 순서를 따른다. 단계를 건너뛰지 말 것.

1. **코드 리서치** — 현재 코드베이스 구조/모듈/의존관계 파악 후 `research.md` 갱신. Spec 시작 전 항상 수행
2. **계획** — 해당 Spec의 세부 태스크, 파일 구조, API 설계, 핵심 코드 스니펫 등을 `specs/spec-NNN.md`에 작성
3. **피드백 반영** — 유저가 주석/코멘트로 피드백. `/feedback`으로 반영 지시 전까지 코드 작성 금지
4. **코드 작성** — `/apply` 호출 후에만 코드 작성. 다중 태스크 실행 시 태스크별로 커밋
5. **테스트** — `/test` 호출로 TDD 사이클 진행 (Red → Green → Refactor)
6. **검증** — 전체 테스트 통과 확인, 이슈 발견 시 보고

### Spec 파일 구조

```
specs/
  001/
    spec.md        ← 전체 spec (태스크는 섹션으로 관리)
    feed-001.md    ← 피드백 이터레이션 (필요 시)
    task-001.md    ← 태스크가 클 때만 별도 파일로 분리 (선택)
```

- 기본: 태스크는 `spec.md` 내 섹션으로 유지
- 태스크가 복잡해지면 `task-NNN.md`로 분리 가능
- `/apply` 실행 시: `spec 전체(/apply 001)`, `특정 태스크(/apply 001/1)`, `피드백(/apply 002/feed-001)`

---

## 커밋 규칙

### Commit Keywords
- `Feat` — 기능 추가
- `Change` — 일반적인 변경 (필드 추가 등)
- `Fix` — 버그 수정
- `Docs` — README 등 일반 문서 수정
- `Agent` — CLAUDE.md, specs/, commands/ 등 에이전트 설정 변경
- `Comment` — 주석 수정
- `Refactor` — 코드 리팩토링
- `Setting` — 빌드, CI, 환경 설정 변경
- `Test` — 테스트 코드 변경

### 형식
```
<Keyword>: <설명>
```

---

## 불확실할 때

구현 방향이 불확실하거나 해석이 여러 가지일 때는 독단적으로 결정하지 말고 먼저 질문할 것.

---

## 금지 사항

- 요청하지 않은 기능 추가 금지
- 요청하지 않은 리팩토링 / 코드 정리 금지
- 요청하지 않은 주석, docstring, 타입 어노테이션 추가 금지
- 불필요한 error handling / fallback 추가 금지
- 작업 완료 후 요약 나열 금지 — diff를 보면 알 수 있음

---

## 바이브코딩 실험 메모

이 프로젝트는 코드 작성과 동시에 **Claude Code 워크플로우 자체를 실험**하는 목적도 있음.
CLAUDE.md, rules, agents 등은 지속적으로 다듬어 나갈 것.
잘 작동한 패턴, 안 작동한 패턴을 발견하면 이 파일에 반영할 것.
