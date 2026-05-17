# Bubbles — Personal AI Counselor with RAG

## 프로젝트 목적

웹 클라이언트에서 general LLM을 연동하여 대화창 구분 없이 항상 나를 기억하는 AI 친구처럼 사용한다.
RAG 시스템으로 과거 기억을 유지하며, 사용자별로 메모리가 개인화되고 직접 수정 가능하다.

---

## 핵심 기능

### 1. 대화 (Chat)
- 단일 모드: 1개 모델과 대화. 메모리는 모델 간 공유, 모델 선택 가능
- 토론 모드: 멀티 응답 후 선택한 모델에게 앞의 응답들을 컨텍스트로 넣어 의견 + 요약 요청
- messages에 `model` 필드 저장 — 어떤 모델과 나눈 대화인지 출처 기록
- 단일 연속 대화창. 구분 없이 항상 이어짐
- 메시지 전송 시 컨텍스트 구성:
  - **main memory** (필수) — 압축된 전체 기억
  - **top N knowledge memories** (유사도 기반 RAG) — 현재 대화와 관련된 세부 기억
  - **최근 메시지** (시간 기반) — 대화 흐름 유지
  - 시스템 프롬프트 + messages 배열로 조립 후 LLM 호출
- LLM 응답은 구조화된 포맷으로 반환 — 응답 텍스트
- general LLM 모델 스위칭 가능 (설정에서 선택)

### 2. 메모리 시스템
- 원문 메시지는 messages 테이블에 저장 (삭제 없이 영구 보관)
- 메모리는 두 레이어로 구성:
  - **knowledge memory** — messages에서 추출한 개별 지식 단위. 임베딩 보유, RAG 검색 대상. md import/export 가능. 망각은 옵션
  - **main memory** — knowledge memories를 압축한 단일 텍스트. 스케줄러 실행마다 재생성
- 스케줄러는 조건 기반으로 트리거 (매초 폴링 아님): 미처리 messages가 N개 이상 쌓이거나 마지막 처리 후 1일이 경과하면 배치 실행. N은 추후 결정:

  - 미처리 messages 임베딩 → 벡터 클러스터링 (HDBSCAN, 클러스터 수 가변)
  - 각 클러스터 ↔ 기존 knowledge memories 비교. merge 조건: `centroid similarity >= 0.8 AND 클러스터 내부 평균 similarity >= 0.7`. 미충족 시 신규 생성. merge 후 해당 knowledge memory 임베딩 재계산
  - HDBSCAN 노이즈 포인트는 `proceeded = false` 유지, 다음 배치 시 새 미처리 messages와 합쳐서 재클러스터링
  - merge / 생성 시 LLM으로 키워드 + 점수 산정 (클러스터 수만큼 병렬 호출)
  - 승격 조건(`is_pinned = true OR (score > 0.9 AND sensitivity <= 0.3)`)을 만족하는 knowledge memories + 기존 main memory → LLM 1회 → main memory 재생성
  - 클러스터에 포함된 messages는 `proceeded = true` 업데이트 + knowledge memory FK 연결. 노이즈 포인트는 `proceeded = false` 유지 (다음 배치에서 재처리)
- 컨텍스트 구성: main memory (필수) + top N knowledge memories (유사도 기반) + 최근 messages (optional)
- knowledge memory 수동 편집/고정(pin)/삭제 가능
- knowledge memory 삭제 시 해당 memory를 참조하는 relation은 제거 — messages 자체는 영구 보관
- 모든 knowledge memory 변경 시 history 적재 — 변경 주체(system: 스케줄러 자동 업데이트 / user: 직접 수정) 기록
- **점수 산정 기준**: `0.25 * importance + 0.25 * durability + 0.20 * reusefulness + 0.20 * confirmed + 0.10 * recency - 0.30 * sensitivity_penalty - 0.30 * temporary_penalty` (각 항목은 0~1 범위, 최종 score도 0~1로 정규화)
  - `importance`는 클러스터 크기 반영: `importance += log(cluster_size)` 후 정규화
- **confirmed**: LLM이 단독으로 부여하는 정적 점수가 아닌 누적 계산값
  - `0.4 * explicit_signal + 0.3 * repetition_score + 0.2 * user_action_score + 0.1 * llm_confidence_hint`
  - `explicit_signal`: 사용자 발화의 확정성 ("~로 정했어" → 높음, "~할까?" → 낮음)
  - `repetition_score`: 유사 memory가 반복 등장한 횟수 (vector similarity 기반)
  - `user_action_score`: pin → 매우 높음, 직접 수정 → 높음, 삭제 → 제외
  - `llm_confidence_hint`: knowledge memory 생성 시 LLM이 보조적으로 제공하는 신뢰도
  - DB에 `explicit_signal`, `repetition_count`, `user_action_score`, `llm_confidence_hint`, `confirmed_score` 분리 저장. 스케줄러 실행 시 재계산

### 3. 키워드 대시보드
- knowledge memory 생성/merge 시 LLM이 추출한 키워드 사용
- 최근성 + 빈도 기반 가중치
- 키워드 클릭 시 관련 knowledge memory 목록 조회

### 4. 지식 관리 (Knowledge Management)
- knowledge memory 목록 조회 (시간순 / 키워드별)
- 개별 삭제, 일괄 삭제, 수동 편집
- md 파일 import (중복 체크 없이 새 knowledge memory로 추가) / export
- main memory 조회 및 수동 편집

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
- **Python 스크립트** (HDBSCAN 클러스터링 전용, NestJS에서 커맨드 실행으로 호출. stdin/stdout으로 데이터 교환, 파일 I/O 없음)

> ChromaDB 미사용: pgvector로 대체하여 Docker 서비스 수를 줄임 (별도 벡터 DB 불필요)

### Infrastructure
- **Docker Compose** (전체 로컬 환경)
  - `frontend` — Next.js
  - `backend` — NestJS
  - `db` — PostgreSQL (pgvector 확장 포함)
  - `ollama` — 로컬 임베딩 모델
  - `clustering` — Python 컨테이너 (HDBSCAN 스크립트 실행 전용)
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
    │     ├── memory 조회 + 최근 messages 선정 → 컨텍스트 조립
    │     ├── 시스템 프롬프트 조립 (기억 주입)
    │     └── LLM API 호출 → { message } 반환
    │
    ├── MemoryModule
    │     ├── 스케줄러: 미처리 messages 임베딩 → HDBSCAN 클러스터링
    │     ├── 스케줄러: 클러스터 ↔ knowledge memories cosine similarity 비교 → merge or 신규 생성
    │     ├── 스케줄러: merge/생성 시 LLM으로 키워드 + 점수 산정
    │     ├── 스케줄러: 승격 조건 만족 knowledge memories + 기존 main memory → LLM → main memory 재생성
    │     ├── knowledge memory 조회 / 편집 / 삭제 / import / export
    │     └── main memory 조회 / 편집
    │
    ├── KeywordModule
    │     ├── knowledge memory 생성/merge 시 키워드 수신 및 저장
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
- [x] (1) Docker Compose 구성 (postgres+pgvector, ollama, clustering, backend, frontend)
- [x] (2) NestJS 프로젝트 초기화
- [x] (3) Next.js 프로젝트 초기화
- [x] (4) DB 설계 및 마이그레이션
- [x] (5) 인증 구현 (JWT)
- [x] (6) LLM 연동 (Ollama 로컬 모델 우선 — `exaone3.5:2.4b`, 외부 API는 Spec 4에서)
- [x] (7) 기본 Chat UI (model null이면 모델 선택 화면 조건부 표시)
- [x] (8) Profile UI (본인 정보 변경, model 변경, API 키 변경)

### Spec 2 — RAG 파이프라인
- [ ] (1) LLM 응답 구조화 포맷 정의 (message)
- [ ] (2) Ollama 임베딩 연동 (message 저장 시 embedding 생성)
- [ ] (3) 스케줄러: 미처리 messages 임베딩 → 벡터 클러스터링 (HDBSCAN)
- [ ] (4) 스케줄러: 클러스터 ↔ 기존 knowledge memories 유사도 비교 → merge or 신규 생성 + LLM으로 키워드/점수 산정
- [ ] (5) 스케줄러: 승격 조건 만족하는 knowledge memories + 기존 main memory → LLM → main memory 재생성
- [ ] (6) 컨텍스트 조립: main memory + top N knowledge memories (RAG) + 최근 messages
- [ ] (7) knowledge memory 목록 UI

### Spec 3 — 지식 관리 & 키워드
- [ ] (1) 키워드 대시보드 UI
- [ ] (2) knowledge memory 수동 편집 / 고정(pin) / 삭제 UI
- [ ] (3) main memory 조회 및 수동 편집 UI
- [ ] (4) md import / export
- [ ] (5) 망각 옵션 (score 기반 knowledge memory 자동 정리)

### Spec 4 — 배포 준비
- [ ] (1) 외부 LLM API 연동 (Claude + GPT 스위칭, license_key 기반)
- [ ] (2) 설정 페이지 (모델 선택, API key 관리)
- [ ] (3) 배포 설정

---

## 용어 정의

| 용어 | 정의 |
|------|------|
| **컨텍스트 버짓 (context budget)** | LLM 호출 시 messages 배열에 넣을 수 있는 총 슬롯. 최근 메시지 수가 이 안에서 결정됨 |
| **knowledge memory** | messages에서 추출한 개별 지식 단위. 임베딩 보유, RAG 검색 대상. md import/export 가능 |
| **main memory** | user당 1개. knowledge memories를 압축한 단일 텍스트. 항상 컨텍스트에 주입 |
| **RAG** | Retrieval-Augmented Generation. knowledge memories를 유사도 기반으로 검색해 LLM 프롬프트에 주입하는 방식 |
| **main memory 승격** | `is_pinned = true OR (score > 0.9 AND sensitivity <= 0.3)` 조건을 만족하는 knowledge memories를 LLM으로 합성한 결과 |
| **license_key** | 유저가 등록한 LLM API 키. provider별로 1개씩 보유하며 해당 provider 호출 시 사용 |
| **망각 (forgetting)** | knowledge memory를 옵션으로 정리하는 과정. messages는 삭제 없이 영구 보관 |
| **temporary_penalty** | knowledge memory 생성/merge 시 LLM이 산정하는 점수 (0~1). 장기 기억으로 남길 가치가 낮을수록 높음. "현재 중요성"이 아닌 "휘발성"을 나타냄. 오늘 날씨·일시적 감정 등은 높고, 직업·가치관·반복 패턴 등은 낮음. score 공식에서 패널티로 작용 |
| **memorize** | 미처리 messages를 클러스터링하여 knowledge memory를 생성/merge하는 과정. 스케줄러 배치의 핵심 단계. |

---

## 메모

- Discord 봇 채널 추가 예정 — 별도 Spec으로 분리. 웹 완성 후 NestJS 백엔드에 Discord 봇 인터페이스만 붙이는 방식
