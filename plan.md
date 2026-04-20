# Bubbles — Personal AI Counselor with RAG

## 프로젝트 목적

웹 클라이언트에서 general LLM을 연동하여 개인 상담사처럼 사용하되, RAG 시스템으로 세션 간 기억을 유지한다.
세션은 짧게 끊어 토큰을 절약하고, 벡터 저장소가 과거 문맥을 대신 기억한다.

---

## 핵심 기능

### 1. 대화 (Chat)
- 새 세션 시작 시 빈 컨텍스트로 시작
- 메시지 전송 시 RAG가 관련 과거 기억을 자동 조회하여 시스템 프롬프트에 주입
- general LLM 모델 스위칭 가능 (설정에서 선택)

### 2. 메모리 시스템 (RAG)
- 대화 중 중요한 내용은 자동으로 임베딩하여 벡터 DB에 저장
- 저장 단위: 발화 단위 or 요약 단위 (추후 결정)
- 조회: 현재 메시지와 유사도 높은 과거 기억 top-k 반환
- 오래되고 조회 빈도 낮은 메모리는 자동 또는 수동 삭제

### 3. 키워드 대시보드
- 내가 자주 언급하는 주제/키워드 추출 및 시각화
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
- **LangChain.js** (RAG 파이프라인, LLM 추상화)
- **PostgreSQL** + **pgvector** 확장 (대화 기록 + 벡터 저장 통합)
- **Ollama** (로컬 임베딩 모델 서빙 — `nomic-embed-text`)

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
    │     ├── RAG 조회 → 관련 메모리 top-k 가져옴
    │     ├── 시스템 프롬프트 조립 (기억 주입)
    │     └── LLM API 호출 (Claude / GPT)
    │
    ├── MemoryModule
    │     ├── 대화 내용 임베딩 (Ollama) → pgvector 저장
    │     ├── 메모리 조회 / 삭제
    │     └── 오래된 메모리 TTL 관리
    │
    ├── KeywordModule
    │     ├── 메모리에서 키워드 추출
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
├── plans/
│   ├── phase-001.md       # Phase별 상세 계획 및 작업 기록
│   └── ...
├── docker-compose.yml
├── .env.example
├── research.md            # 코드베이스 현황 스냅샷 (Phase마다 업데이트)
├── CLAUDE.md
└── plan.md
```

모노레포: 단순 `apps/` 폴더 구조

---

## 개발 단계

### Phase 1 — 기반 세팅
- [ ] Docker Compose 구성 (postgres+pgvector, ollama, backend, frontend)
- [ ] NestJS 프로젝트 초기화
- [ ] Next.js 프로젝트 초기화
- [ ] LLM API 연동 (Claude + GPT 스위칭)
- [ ] 기본 Chat UI

### Phase 2 — RAG 파이프라인
- [ ] 대화 내용 임베딩 (Ollama) → pgvector 저장
- [ ] 메시지 전송 시 관련 메모리 조회
- [ ] 시스템 프롬프트에 기억 주입
- [ ] 메모리 목록 UI

### Phase 3 — 키워드 & 메모리 관리
- [ ] 키워드 추출 로직
- [ ] 키워드 대시보드 UI
- [ ] 메모리 TTL / 자동 정리
- [ ] 메모리 수동 편집 UI

### Phase 4 — 인증 & 배포 준비
- [ ] 인증 구현 (초기: 간단한 JWT 로그인, 추후 소셜 로그인 고려)
- [ ] 설정 페이지 (모델 선택, API key 관리)
- [ ] 배포 설정

---


---

## 메모

- **메모리 저장 단위** (발화별 vs 세션 요약): 구현 방식에 따라 성능/비용 트레이드오프 있음. 나중에 바꿀 수 있도록 MemoryModule을 추상화해서 설계할 것.
