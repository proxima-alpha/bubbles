# Spec 001 — 기반 세팅

## 목표

프로젝트 골격 세팅. 이후 모든 Spec의 기반이 되는 인프라, 인증, LLM 연동, 기본 Chat UI를 완성한다.

---

## 태스크

- [ ] 1. Docker Compose 구성
- [ ] 2. NestJS 프로젝트 초기화
- [ ] 3. Next.js 프로젝트 초기화
- [ ] 4. DB 설계 및 마이그레이션
- [ ] 5. 인증 구현 (JWT)
- [ ] 6. LLM API 연동 (Claude + GPT, 멀티모델 구조)
- [ ] 7. 기본 Chat UI

---

## 디렉토리 구조

```
bubbles/
├── apps/
│   ├── frontend/          # Next.js 14
│   └── backend/           # NestJS
├── specs/
├── docker-compose.yml
├── .env.example
├── research.md
├── CLAUDE.md
└── plan.md
```

---

## 1. Docker Compose

서비스 5개 (clustering은 Spec 2에서 실제 사용):

| 서비스 | 이미지 | 포트 |
|--------|--------|------|
| `db` | `pgvector/pgvector:pg16` | 5432 |
| `ollama` | `ollama/ollama` | 11434 |
| `clustering` | 로컬 빌드 (Python) | — |
| `backend` | 로컬 빌드 | 3001 |
| `frontend` | 로컬 빌드 | 3000 |

---

## 2. DB 설계

### common_code_categories
공통코드 분류. enum 대신 사용하는 코드 그룹 정의.

| 컬럼 | 타입 | 비고 |
|------|------|------|
| code | varchar | PK |
| name | varchar | |
| description | text | nullable |
| sort_order | int | |
| is_active | boolean | default true |
| created_at | timestamptz | |

초기 데이터:

| code | name |
|------|------|
| `role` | 메시지 역할 |
| `model` | LLM 모델 |
| `memory_type` | 메모리 유형 |
| `memory_history_type` | 메모리 히스토리 유형 |

### common_codes
공통코드. composite PK `(category_code, code)`.

| 컬럼 | 타입 | 비고 |
|------|------|------|
| category_code | varchar | PK, FK → common_code_categories.code |
| code | varchar | PK |
| name | varchar | |
| description | text | nullable |
| value | text | nullable |
| sort_order | int | |
| is_active | boolean | default true |
| created_at | timestamptz | |

다른 테이블에서 참조 시 composite FK `(bbb_category, bbb)` → `(category_code, code)`. `_code` 접미사 생략.

초기 데이터:
- `role`: `user` (사용자), `assistant` (AI)
- `model`: `claude` (Claude), `gpt` (GPT)
- `memory_type`: `main` (메인 메모리), `knowledge` (지식 메모리)
- `memory_history_type`: `created` (시스템 자동 생성), `renewed` (시스템 자동 수정), `uploaded` (이용자 수동 업로드), `modified` (이용자 수동 수정)

### users

| 컬럼 | 타입 | 비고 |
|------|------|------|
| id | uuid | PK |
| email | varchar | unique |
| password | varchar | SHA256 해시값 |
| salt | varchar | SHA256 salt |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### license_keys

| 컬럼 | 타입 | 비고 |
|------|------|------|
| id | uuid | PK |
| key | varchar | unique |
| user_id | uuid | FK → users (nullable) |
| model_category | varchar | composite FK → common_codes.category_code |
| model | varchar | composite FK → common_codes.code |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### messages

| 컬럼 | 타입 | 비고 |
|------|------|------|
| id | uuid | PK |
| user_id | uuid | FK → users (nullable) |
| role_category | varchar | composite FK → common_codes.category_code |
| role | varchar | composite FK → common_codes.code (`user` / `assistant`) |
| content | text | |
| model_category | varchar | composite FK → common_codes.category_code. user 메시지는 null |
| model | varchar | composite FK → common_codes.code. user 메시지는 null |
| embedding | vector(768) | Spec 2에서 채움. 컬럼만 생성 |
| is_proceeded | boolean | default false. 스케줄러 처리 여부 |
| created_at | timestamptz | |

---

## 3. NestJS 모듈 구조

```
backend/src/
├── auth/
│   ├── auth.module.ts
│   ├── auth.controller.ts   # POST /auth/register, POST /auth/login
│   ├── auth.service.ts
│   └── dto/
├── chat/
│   ├── chat.module.ts
│   ├── chat.controller.ts   # POST /chat, GET /chat/history
│   ├── chat.service.ts
│   └── dto/
├── model/
│   ├── model.module.ts
│   ├── model.service.ts     # LLM 어댑터 인터페이스
│   ├── providers/
│   │   ├── claude.provider.ts
│   │   └── openai.provider.ts
│   └── dto/
├── prisma/
│   ├── prisma.module.ts
│   └── prisma.service.ts
└── app.module.ts
```

---

## 4. API 설계

### Auth
```
POST /auth/register   { email, password } → { accessToken }
POST /auth/login      { email, password } → { accessToken }
```

### Chat
```
POST /chat            { content, model? } → { content, model }
GET  /chat/history                       → Message[]
```

- `model` 미전달 시 설정값 기본 모델 사용
- 모든 Chat 엔드포인트는 JWT Bearer 인증 필요

---

## 5. LLM 연동

단일 모드 / 토론 모드 모두 지원 가능한 구조로 추상화:

```typescript
interface LlmProvider {
  chat(messages: LlmMessage[], systemPrompt: string): Promise<LlmResponse>
}

interface LlmResponse {
  content: string
  model: string   // 실제 사용된 모델명 기록용
}
```

토론 모드 (Spec 1 범위 밖, 구조만 고려):
- 여러 provider에 동일 메시지 병렬 호출 → 응답 배열 반환
- 취합 요청 시 선택 모델에 앞 응답들 컨텍스트로 주입

---

## 6. Next.js 구조

```
frontend/src/app/
├── (auth)/
│   ├── login/page.tsx
│   └── register/page.tsx
├── chat/
│   └── page.tsx             # 메인 채팅 화면
├── layout.tsx
└── providers.tsx            # React Query Provider
```

### Chat UI 핵심 요소
- 메시지 목록 (스크롤)
- 입력창 + 전송 버튼
- 사용자 / AI 메시지 구분 표시
- 모델 선택 드롭다운 (단일 모드)

---

## 환경변수 (.env.example)

```
# DB
DATABASE_URL=postgresql://bubbles:bubbles@localhost:5432/bubbles

# JWT
JWT_SECRET=

# LLM
LLM_DEFAULT_PROVIDER=claude   # claude | openai
ANTHROPIC_API_KEY=
OPENAI_API_KEY=

# Ollama
OLLAMA_BASE_URL=http://ollama:11434
```

---

## 결정 사항

- Ollama 임베딩 연동은 Spec 2로 미룸 — messages.embedding 컬럼만 생성
- 토론 모드 UI는 Spec 2 이후로 미룸 — LLM 인터페이스만 멀티모델 대응으로 설계
- clustering 컨테이너는 Docker Compose에 포함하되 Spec 2까지 미사용
- **미결**: model 버전 선택 방식 — common_codes의 `claude`/`gpt`는 provider 단위. 실제 호출 버전(claude-3-5-sonnet 등)을 공통코드로 관리할지, 환경변수/설정으로 관리할지 결정 필요
