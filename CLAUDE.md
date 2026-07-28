# CLAUDE.md — Bubbles 프로젝트

Claude Code가 이 프로젝트에서 따라야 할 규칙과 컨텍스트.
프로젝트 개요/기술 스택 등 프로젝트 내용은 `plan.md` 참고.

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
- DB 스키마, 공통코드, REST API/페이지네이션 상세 규칙은 `docs/conventions.md` 참고

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

### plan.md vs spec.md

- `plan.md` "개발 단계" — Spec별 **MVP 범위만** 작성 (체크박스 없이 요약 문장/bullet)
- 세부 태스크 체크리스트는 `specs/NNN/spec.md`에서만 관리
- 이유: 두 곳에서 체크리스트를 관리하면 진행 상황이 어긋남 (plan.md가 갱신 안 되고 방치되는 문제 발생)

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
