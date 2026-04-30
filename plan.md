# Bubbles — Personal AI Counselor with RAG

## 프로젝트 목적

웹 클라이언트에서 general LLM을 연동하여 대화창 구분 없이 항상 나를 기억하는 AI 친구처럼 사용한다.
RAG 시스템으로 과거 기억을 유지하며, 사용자별로 메모리가 개인화되고 직접 수정 가능하다.

---

## 핵심 기능

### 1. 대화 (Chat)
- 단일 연속 대화창. 구분 없이 항상 이어짐
- 메시지 전송 시 컨텍스트 구성:
  - **최근 메시지** (시간 기반) — 대화 흐름 유지
  - **관련 과거 메모리** (유사도 기반 RAG) — 오래된 맥락 보완
  - 두 레이어를 합쳐 시스템 프롬프트 + messages 배열로 조립 후 LLM 호출
  - 각 레이어의 개수는 컨텍스트 버짓 내에서 유동적으로 결정
- LLM 응답은 구조화된 포맷으로 반환 — 응답 텍스트 + 키워드 동시 추출
- general LLM 모델 스위칭 가능 (설정에서 선택)

### 2. 메모리 시스템 (RAG)
- 원문 메시지는 messages 테이블에 저장
- 스케줄러가 주기적으로 미처리 메시지를 배치 처리:
  - 기존 memories + 미처리 messages를 LLM에 전송
  - LLM이 이미 기억된 내용을 고려하여 새로 기억할 내용만 추출
  - 추출된 메모리를 임베딩하여 pgvector에 저장
  - 처리된 messages는 memorized 플래그 업데이트
- 조회: 유사도 + 망각 점수 기반으로 컨텍스트 버짓 내에서 선정
- 사용자별 메모리 개인화 — 다른 사용자의 메모리와 완전 분리
- 메모리 수동 편집/삭제 가능 (투명성 보장)
- **망각 전략 (하드 캡 + decay)**:
  - 사용자당 최대 N개 하드 캡
  - 망각 점수 = `access_count / (1 + 경과일수)` — 오래되고 조회 안 된 메모리일수록 낮아짐
  - 스케줄러 실행 시 캡 초과하면 점수 낮은 것부터 삭제

### 3. 키워드 대시보드
- LLM 응답 포맷에서 키워드 추출 (별도 API 호출 없음)
- 최근성 + 빈도 기반 가중치
- 키워드 클릭 시 관련 메모리 목록 조회

### 4. 메모리 관리
- 저장된 메모리 목록 조회 (시간순 / 키워드별)
- 개별 삭제, 일괄 삭제
- 메모리 수동 편집

---

## 기술 스택

### Frontend
- **Next.js 14** (App Router)
- **Tailwind CSS** + shadcn/ui
- **React Query** (서버 상태 관리)

### Backend
- **NestJS** (TypeScript, DI 구조)
- **Prisma** (ORM, 마이그레이션)
- **PostgreSQL** + **pgvector** 확장 (대화 기록 + 벡터 저장 통합)
- **Ollama** (로컬 임베딩 모델 서빙 — `nomic-embed-text`)
- RAG 파이프라인은 직접 구현 (LangChain 미사용)

> ChromaDB 미사용: pgvector로 대체하여 Docker 서비스 수를 줄임 (별도 벡터 DB 불필요)

### Infrastructure
- **Docker Compose** (전체 로컬 환경)
  - `frontend` — Next.js
  - `backend` — NestJS
  - `db` — PostgreSQL (pgvector 확장 포함)
  - `ollama` — 로컬 임베딩 모델
- 추후 배포: Railway / Render / VPS (Docker 그대로)

---

## 아키텍처 개요

```
Browser (Next.js)
    │
    ▼
NestJS API
    ├── ChatModule
    │     ├── 메시지 수신
    │     ├── RAG 조회 → 컨텍스트 버짓 내에서 메모리 선정
    │     ├── 시스템 프롬프트 조립 (기억 주입)
    │     └── LLM API 호출 → { message, keywords } 반환
    │
    ├── MemoryModule
    │     ├── 스케줄러: 기존 memories(list) + 미처리 messages → LLM → 새 memories 저장
    │     ├── 망각: 캡 초과 시 점수 낮은 memories 삭제
    │     └── 메모리 조회 / 삭제
    │
    ├── KeywordModule
    │     ├── LLM 응답에서 키워드 수신 및 저장
    │     └── 빈도 / 최근성 집계
    │
    └── ConfigModule
          └── LLM provider / model 설정
```

---

## 디렉토리 구조 (예정)

```
bubbles/
├── apps/
│   ├── frontend/          # Next.js
│   └── backend/           # NestJS
├── specs/
│   ├── spec-001.md        # Spec별 상세 계획 및 작업 기록
│   └── ...
├── docker-compose.yml
├── .env.example
├── research.md            # 코드베이스 현황 스냅샷 (Spec마다 업데이트)
├── CLAUDE.md
└── plan.md
```

모노레포: 단순 `apps/` 폴더 구조

---

## 개발 단계

### Spec 1 — 기반 세팅
- [ ] Docker Compose 구성 (postgres+pgvector, ollama, backend, frontend)
- [ ] NestJS 프로젝트 초기화
- [ ] Next.js 프로젝트 초기화
- [ ] DB 설계 및 마이그레이션
- [ ] 인증 구현 (JWT)
- [ ] LLM API 연동 (Claude + GPT 스위칭)
- [ ] 기본 Chat UI

### Spec 2 — RAG 파이프라인
- [ ] LLM 응답 구조화 포맷 정의 (message + keywords)
- [ ] 스케줄러 기반 메모리 추출 (미처리 messages → LLM → memories)
- [ ] 메시지 전송 시 컨텍스트 버짓 내 메모리 조회 및 주입
- [ ] 메모리 목록 UI

### Spec 3 — 키워드 & 메모리 관리
- [ ] 키워드 대시보드 UI
- [ ] 메모리 TTL / 자동 정리
- [ ] 메모리 수동 편집 UI

### Spec 4 — 배포 준비
- [ ] 설정 페이지 (모델 선택, API key 관리)
- [ ] 배포 설정

---

## 용어 정의

| 용어 | 정의 |
|------|------|
| **컨텍스트 버짓 (context budget)** | LLM 호출 시 messages 배열에 넣을 수 있는 총 슬롯. 최근 메시지 수 + 메모리 수가 이 안에서 유동적으로 결정됨 |
| **메모리 (memory)** | 스케줄러가 대화에서 추출한 기억할 만한 내용. 임베딩되어 pgvector에 저장됨 |
| **RAG** | Retrieval-Augmented Generation. 과거 메모리를 유사도+시간 기반으로 검색해 LLM 프롬프트에 주입하는 방식 |

---

## 메모

- MemoryModule은 저장 단위 변경 가능성을 고려해 인터페이스로 설계할 것
