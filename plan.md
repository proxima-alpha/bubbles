# Bubbles — Personal AI Counselor with RAG

## 프로젝트 목적

웹 클라이언트에서 general LLM을 연동하여 대화창 구분 없이 항상 나를 기억하는 AI 친구처럼 사용한다.
RAG 시스템으로 과거 기억을 유지하며, 사용자별로 메모리가 개인화되고 직접 수정 가능하다.

---

## 핵심 기능

### 1. 대화 (Chat)
- 하나의 연속된 대화창. 세션 구분 없이 항상 이어짐
- 메시지 전송 시 컨텍스트 구성:
  - **최근 N개 메시지** (시간 기반) — 대화 흐름 유지
  - **관련 과거 메모리** (유사도 기반 RAG) — 오래된 맥락 보완
  - 두 레이어를 합쳐 시스템 프롬프트 + messages 배열로 조립 후 LLM 호출
- general LLM 모델 스위칭 가능 (설정에서 선택)

### 2. 메모리 시스템 (RAG)
- 모든 대화 내용을 임베딩하여 벡터 DB에 저장
- 저장 단위: 발화 단위 or 요약 단위 (추후 결정)
- 조회: 시간(최근성) + 유사도 하이브리드로 top-k 선정 (k는 질문·응답 길이에 따라 유동)
- 사용자별 메모리 개인화 — 다른 사용자의 메모리와 완전 분리
- 메모리 수동 편집/삭제 가능 (투명성 보장)
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

## DB 설계

### sessions
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | uuid | PK |
| started_at | timestamp | 세션 시작 시각 |
| ended_at | timestamp | 세션 종료 시각 (null이면 진행 중) |

### messages
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | uuid | PK |
| session_id | uuid | FK → sessions |
| role | enum | `user` / `assistant` |
| content | text | 메시지 내용 |
| created_at | timestamp | |

### memories
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | uuid | PK |
| content | text | 임베딩 원문 |
| embedding | vector | pgvector 임베딩 |
| created_at | timestamp | |
| last_accessed_at | timestamp | TTL 관리용 |
| access_count | int | 조회 빈도 (TTL 가중치) |

### keywords
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | uuid | PK |
| word | text | 키워드 |
| count | int | 누적 빈도 |
| last_seen_at | timestamp | 최근성 계산용 |

### memory_keywords (중간 테이블)
| 컬럼 | 타입 | 설명 |
|------|------|------|
| memory_id | uuid | FK → memories |
| keyword_id | uuid | FK → keywords |

---

## 개발 단계

### Spec 1 — 기반 세팅
- [ ] Docker Compose 구성 (postgres+pgvector, ollama, backend, frontend)
- [ ] NestJS 프로젝트 초기화
- [ ] Next.js 프로젝트 초기화
- [ ] LLM API 연동 (Claude + GPT 스위칭)
- [ ] 기본 Chat UI

### Spec 2 — RAG 파이프라인
- [ ] 대화 내용 임베딩 (Ollama) → pgvector 저장
- [ ] 메시지 전송 시 관련 메모리 조회
- [ ] 시스템 프롬프트에 기억 주입
- [ ] 메모리 목록 UI

### Spec 3 — 키워드 & 메모리 관리
- [ ] 키워드 추출 로직
- [ ] 키워드 대시보드 UI
- [ ] 메모리 TTL / 자동 정리
- [ ] 메모리 수동 편집 UI

### Spec 4 — 인증 & 배포 준비
- [ ] 인증 구현 (초기: 간단한 JWT 로그인, 추후 소셜 로그인 고려)
- [ ] 설정 페이지 (모델 선택, API key 관리)
- [ ] 배포 설정

---


---

## 용어 정의

| 용어 | 정의 |
|------|------|
| **세션** | 하나의 연속된 대화창. 컨텍스트가 유지되는 구간. 이 앱에서는 단일 세션으로 항상 이어짐 |
| **RAG** | Retrieval-Augmented Generation. 과거 메모리를 유사도+시간 기반으로 검색해 LLM 프롬프트에 주입하는 방식 |

---

## 메모

- **메모리 저장 단위** (발화별 vs 세션 요약): 구현 방식에 따라 성능/비용 트레이드오프 있음. 나중에 바꿀 수 있도록 MemoryModule을 추상화해서 설계할 것.
