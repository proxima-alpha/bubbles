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
- **RAG**: LangChain.js, pgvector (PostgreSQL 확장), Ollama (`nomic-embed-text`)
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
- 비즈니스 로직은 Service에, 라우팅은 Controller에
- DTO는 `class-validator`로 유효성 검사
- 환경변수는 `@nestjs/config`로 관리, 하드코딩 금지

### Frontend (Next.js)
- Server Component 기본, 상태가 필요한 경우에만 Client Component
- API 호출은 Axios + React Query로 통일
- UI 컴포넌트는 shadcn/ui 먼저 확인 후 없으면 직접 작성

---

## 의사결정 기준

- **추가 비용 없는 선택 우선** — 유료 외부 서비스보다 로컬/오픈소스 선호
- **단순함 우선** — 토이프로젝트이므로 오버엔지니어링 금지
- **추상화는 실제로 필요할 때** — 미래를 위한 추상화 금지, 단 MemoryModule은 저장 단위 변경 가능성을 고려해 인터페이스로 설계
- 기술 선택에 트레이드오프가 있으면 먼저 제시하고 결정을 요청할 것

---

## 워크플로우

각 Spec은 아래 순서를 따른다. 단계를 건너뛰지 말 것.

1. **코드 리서치** — 현재 코드베이스 구조/모듈/의존관계 파악 후 `research.md` 갱신. Spec 시작 전 항상 수행
2. **계획** — 해당 Spec의 세부 태스크, 파일 구조, API 설계, 핵심 코드 스니펫 등을 `specs/spec-NNN.md`에 작성
3. **피드백 반영** — 유저가 주석/코멘트로 피드백. `/feedback`으로 반영 지시 전까지 코드 작성 금지
4. **코드 작성** — `/apply` 호출 후에만 코드 작성
5. **테스트** — `/test` 호출로 TDD 사이클 진행 (Red → Green → Refactor)
6. **검증** — 전체 테스트 통과 확인, 이슈 발견 시 보고

Spec이 너무 복잡해지면 서브스펙으로 쪼갠다. 서브스펙 파일명은 `specs/spec-NNN-NNN.md` 형식 (예: `spec-001-001.md`은 spec-001의 첫 번째 서브스펙).

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
