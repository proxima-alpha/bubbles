# Spec 001 — 기반 세팅

## 목표

프로젝트 골격 세팅. 이후 모든 Spec의 기반이 되는 인프라, 인증, LLM 연동, 기본 Chat UI를 완성한다.

---

## 태스크

[//]: # (체크박스만 사용)
- [ ] 1. Docker Compose 구성
- [ ] 2. NestJS 프로젝트 초기화
- [ ] 3. Next.js 프로젝트 초기화
- [ ] 4. DB 설계 및 마이그레이션
- [ ] 5. 인증 구현 (JWT)
- [ ] 6. LLM API 연동
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

서비스 4개:

| 서비스 | 이미지 | 포트 |
|--------|--------|------|
| `db` | `pgvector/pgvector:pg16` | 5432 |
| `ollama` | `ollama/ollama` | 11434 |
| `backend` | 로컬 빌드 | 3001 |
| `frontend` | 로컬 빌드 | 3000 |

---

[//]: # (전체적으로, boolean 필드명은 is_xxx로)
[//]: # (공통코드 테이블 추가, enum 사용 금지, recursive 하게 관계 맺어서 분류그룹 할당 가능하도록, code-pk, name 필드 추가해서)
[//]: # (라이센스 키 테이블 추가, 공통코드 fk로 연결)
## 2. DB 설계

[//]: # (salt 필드 추가, sha256 salt용)
[//]: # (password_hash -> password 로 필드명 변경)
### users
| 컬럼 | 타입 | 비고 |
|------|------|------|
| id | uuid | PK |
| email | varchar | unique |
| password_hash | varchar | |
| created_at | timestamptz | |

[//]: # (user_id nullable로 처리)
[//]: # (role 에 공통코드 FK 로 연결, role_category 필드 추가, 공통코드 FK로 연결)

### messages
| 컬럼 | 타입 | 비고                 |
|------|------|--------------------|
| id | uuid | PK                 |
| user_id | uuid | FK → users |
| role | enum(user, assistant) |                    |
| content | text |                    |
| keywords | text[] | LLM 응답에서 추출        |
| embedding | vector(768) | nomic-embed-text 출력 차원 |
| memorized | boolean | default false      |
| created_at | timestamptz |                    |

### memories
| 컬럼 | 타입 | 비고 |
|------|------|------|
| id | uuid | PK |
| user_id | uuid | FK → users, unique |
| content | text | |
| updated_at | timestamptz | |

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
POST /chat            { message } → { message, keywords }
GET  /chat/history    → Message[]
```

모든 Chat 엔드포인트는 JWT Bearer 인증 필요.

---

## 5. LLM 응답 포맷

LLM은 아래 JSON 형식으로 응답하도록 시스템 프롬프트 지정:

```json
{
  "message": "응답 텍스트",
  "keywords": ["키워드1", "키워드2"]
}
```

LLM provider는 인터페이스로 추상화하여 Claude ↔ GPT 스위칭 가능하게 설계:

```typescript
interface LlmProvider {
  chat(messages: LlmMessage[], systemPrompt: string): Promise<LlmResponse>
}
```

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
- 사용자/AI 메시지 구분 표시

---

## 환경변수 (.env.example)

```
# DB
DATABASE_URL=postgresql://bubbles:bubbles@localhost:5432/bubbles

# JWT
JWT_SECRET=

# LLM
LLM_PROVIDER=claude   # claude | openai
ANTHROPIC_API_KEY=
OPENAI_API_KEY=

# Ollama
OLLAMA_BASE_URL=http://localhost:11434
```

---

## 결정 사항

- Ollama 임베딩 연동은 Spec 2로 미룸 — messages 테이블에 embedding 컬럼은 만들어두되 채우는 로직은 제외
