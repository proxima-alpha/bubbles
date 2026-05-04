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

[//]: # (salt 필드 추가, sha256 salt용)
[//]: # (password_hash -> password 로 필드명 변경)
### common_codes
공통코드. enum 대신 사용. recursive FK로 분류 그룹 표현.

| 컬럼 | 타입 | 비고 |
|------|------|------|
| code | varchar | PK |
| parent_code | varchar | FK → common_codes (nullable) |
| name | varchar | |
| created_at | timestamptz | |

[//]: # (full name 사용, 소문자 사용, msg_role -> chat_role)
[//]: # (model 추가 - 초기값 claude, gpt, 근데 버전은 어케선택하누)
초기 데이터:
- `MSG_ROLE` (name: 메시지 역할)
  - `MSG_ROLE.USER` (name: 사용자)
  - `MSG_ROLE.ASSISTANT` (name: AI)

### users

| 컬럼 | 타입 | 비고 |
|------|------|------|
| id | uuid | PK |
| email | varchar | unique |
| password | varchar | SHA256 해시값 |
| salt | varchar | SHA256 salt |
| created_at | timestamptz | |

[//]: # (user_id nullable로 처리)
[//]: # (role 에 공통코드 FK 로 연결, role_category 필드 추가, 공통코드 FK로 연결)
### license_keys

| 컬럼 | 타입 | 비고 |
|------|------|------|
| id | uuid | PK |
| key | varchar | unique |
| user_id | uuid | FK → users (nullable) |
| type_code | varchar | FK → common_codes |
| created_at | timestamptz | |

### memories
### messages

| 컬럼 | 타입 | 비고 |
|------|------|------|
| id | uuid | PK |
| user_id | uuid | FK → users (nullable) |
| role_code | varchar | FK → common_codes (`MSG_ROLE.USER` / `MSG_ROLE.ASSISTANT`) |
| content | text | |
| model | varchar | 응답 모델명 (e.g. `claude-3-5-sonnet-20241022`). user 메시지는 null |
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
├── llm/
│   ├── llm.module.ts
│   ├── llm.service.ts       # LLM 어댑터 인터페이스
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
