# Spec 001 — 기반 세팅

## 목표

프로젝트 골격 세팅. 이후 모든 Spec의 기반이 되는 인프라, 인증, LLM 연동, 기본 Chat UI를 완성한다.

---

## 태스크

- [x] (1) Docker Compose 구성
- [x] (2) NestJS 프로젝트 초기화
- [x] (3) Next.js 프로젝트 초기화
- [x] (4) DB 설계 및 마이그레이션 (updated_at 자동 갱신 트리거 포함)
- [x] (5) 인증 구현 (JWT)
- [x] (6) LLM 연동 (Ollama — `qwen2.5:3b`)
- [x] (7) 기본 Chat UI (user.model null이면 조건부로 모델 선택 화면 표시)
- [x] (8) Profile UI (본인 정보 변경, model 변경, API 키 변경)

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

컬럼 선언 순서: PK → ID FK → Code FK → 일반 필드 → is_xxx boolean → xxx_at (추가) → created_at / updated_at / deleted_at

### common_code_category
공통코드 분류. enum 대신 사용하는 코드 그룹 정의.

| 컬럼 | 타입 | 비고 |
|------|------|------|
| code | varchar | PK |
| name | varchar | |
| description | text | nullable |
| order | int | |
| is_active | boolean | default true |
| created_at | timestamptz | |
| updated_at | timestamptz | |

초기 데이터:

| code | name |
|------|------|
| `role` | 메시지 역할 |
| `provider` | LLM provider |
| `model` | LLM 모델 버전 |
| `memory_type` | 메모리 유형 |
| `memory_history_type` | 메모리 히스토리 유형 |

### common_code
공통코드. composite PK `(category_code, code)`.

| 컬럼 | 타입 | 비고 |
|------|------|------|
| category_code | varchar | PK, FK → common_code_category.code |
| code | varchar | PK |
| parent_category_code | varchar | nullable. `(parent_category_code, parent_code)` composite FK → `common_code(category_code, code)` |
| parent_code | varchar | nullable |
| name | varchar | |
| description | text | nullable |
| value | text | nullable |
| order | int | |
| is_active | boolean | default true |
| created_at | timestamptz | |
| updated_at | timestamptz | |

다른 테이블에서 참조 시 composite FK `(bbb_category, bbb)` → `(category_code, code)`. `_code` 접미사 생략.

초기 데이터:
- `role`: `user` (사용자), `assistant` (AI)
- `provider`: `ollama` (Ollama 로컬)
- `model`: `qwen2.5:3b` (Qwen 2.5 3B, parent: `provider/ollama`)
- `memory_type`: `main` (메인 메모리), `knowledge` (지식 메모리)
- `memory_history_type`: `created` (시스템 자동 생성), `renewed` (시스템 자동 수정), `uploaded` (이용자 수동 업로드), `modified` (이용자 수동 수정)

### user

| 컬럼 | 타입 | 비고 |
|------|------|------|
| id | uuid | PK |
| model_category | varchar | default `'model'`. composite FK → common_code.category_code |
| model | varchar | nullable. composite FK → common_code.code. 사용자가 선택한 LLM 모델. null이면 403 |
| email | varchar | unique |
| password | varchar | SHA256 해시값 |
| salt | varchar | SHA256 salt |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### license_key

유저가 등록한 LLM provider별 API 키. provider 호출 시 해당 유저의 키를 사용. provider당 1개 — upsert로 관리.

| 컬럼 | 타입 | 비고 |
|------|------|------|
| id | uuid | PK |
| user_id | uuid | FK → user |
| provider_category | varchar | default `'provider'`. composite FK → common_code.category_code |
| provider | varchar | composite FK → common_code.code (`claude` / `gpt`) |
| key | varchar | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

UNIQUE `(user_id, provider)`

### message

| 컬럼 | 타입 | 비고 |
|------|------|------|
| id | uuid | PK |
| user_id | uuid | FK → user. assistant 메시지도 해당 대화를 발생시킨 user의 id |
| role_category | varchar | default `'role'`. composite FK → common_code.category_code |
| role | varchar | composite FK → common_code.code (`user` / `assistant`) |
| provider_category | varchar | default `'provider'`. composite FK → common_code.category_code |
| provider | varchar | nullable. composite FK → common_code.code. user 메시지의 provider는 null. 프로필 아이콘 표시용 |
| model_category | varchar | default `'model'`. composite FK → common_code.category_code |
| model | varchar | nullable. composite FK → common_code.code (실제 호출 버전). user 메시지의 model은 null |
| content | text | |
| embedding | vector(768) | Spec 2에서 채움. 컬럼만 생성 |
| is_proceeded | boolean | default false. 스케줄러 처리 여부 |
| created_at | timestamptz | |

### memory
memory_content의 그룹. self-referencing으로 버전 히스토리 관리.

| 컬럼 | 타입 | 비고 |
|------|------|------|
| id | uuid | PK |
| user_id | uuid | FK → user |
| root_memory_id | uuid | FK → memory.id (nullable, 루트 본인은 null) |
| parent_memory_id | uuid | FK → memory.id (nullable, 이전 버전 id) |
| type_category | varchar | default `'memory_type'`. composite FK → common_code.category_code |
| type | varchar | composite FK → common_code.code (`memory_type`: main / knowledge) |
| history_type_category | varchar | default `'memory_history_type'`. composite FK → common_code.category_code |
| history_type | varchar | composite FK → common_code.code (`memory_history_type`. nullable, 최초 생성은 null) |
| keywords | varchar[] | |
| version | int | 1부터 시작. 수정(이용자/자동 모두)마다 +1 |
| is_pinned | boolean | default false |
| is_active | boolean | default true |
| deactivated_at | timestamptz | nullable |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### memory_content
memory의 하위 컨텐츠 청크.

| 컬럼 | 타입 | 비고 |
|------|------|------|
| id | uuid | PK |
| memory_id | uuid | FK → memory |
| content | text | |
| order | int | |
| created_at | timestamptz | |

### memory_content__message
memory_content 생성 시 근거가 된 message 그룹을 연결. memory_content가 생성될 때 함께 적재. Spec 2에서 채움.

| 컬럼 | 타입 | 비고 |
|------|------|------|
| memory_content_id | uuid | PK, FK → memory_content |
| message_id | uuid | PK, FK → message |
| created_at | timestamptz | |

---

## 3. NestJS 모듈 구조

`model` 모듈로 LLM 어댑터 추상화 (`model`은 NestJS 예약어 아님).

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
├── user/
│   ├── user.module.ts
│   ├── user.controller.ts   # GET /user, PUT /user, PUT /user/model, PUT /user/license-key
│   ├── user.service.ts
│   └── dto/
├── model/
│   ├── model.module.ts
│   ├── model.service.ts     # LLM 어댑터 인터페이스
│   ├── providers/
│   │   └── ollama.provider.ts
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
POST /auth/register   { email, password, model, licenseKeys: [{ provider, key }] } → { accessToken }
POST /auth/login      { email, password } → { accessToken }
```

### User
```
GET  /user            → { email, model }
PUT  /user            { email?, password? } → { }
PUT  /user/model      { model } → { }
```

- 모든 User 엔드포인트는 JWT Bearer 인증 필요
- `PUT /user/model`: 유효한 common_code model 값이 아니면 400 반환

### Chat
```
POST /chat            { content } → { content, provider, model }
GET  /chat/history                 → Message[]
```

- 모든 Chat 엔드포인트는 JWT Bearer 인증 필요
- `user.model`이 null이면 403 반환

---

## 5. LLM 연동

`model` 모듈에 provider별 어댑터를 두고, `ChatService`가 `ModelService`를 통해 호출하는 구조.

- `ollama.provider.ts` — Ollama REST API 사용 (`OLLAMA_BASE_URL` 환경변수)
- `ModelService`가 `user.model` → parent provider 역참조 후 어댑터 선택

응답 shape (`POST /chat` 반환):
```
{ content: string, provider: string, model: string }
```
- `provider`: 호출에 사용된 provider 코드 (예: `claude`)
- `model`: 실제 호출 버전 (예: `claude-opus-4-7`)

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
├── profile/
│   └── page.tsx             # 프로필 (본인 정보 변경, model 변경, API 키 변경)
├── layout.tsx
└── providers.tsx            # React Query Provider
```

### Register UI 핵심 요소
- 이메일 / 비밀번호 입력
- model 선택 (common_code `model` 목록)

### Chat UI 핵심 요소
- 메시지 목록 (스크롤)
- 입력창 + 전송 버튼
- 사용자 / AI 메시지 구분 표시 (provider 프로필 아이콘 포함)
- `user.model`이 null인 경우 채팅창 대신 모델 선택 화면 표시

### Profile UI 핵심 요소
- 이메일 / 비밀번호 변경
- model 변경

---

## 환경변수 (.env.example)

```
# DB
DATABASE_URL=postgresql://bubbles:bubbles@localhost:5432/bubbles

# JWT
JWT_SECRET=

# Ollama
OLLAMA_BASE_URL=http://ollama:11434
```

---

## 결정 사항

- Ollama 임베딩 연동은 Spec 2로 미룸 — message.embedding 컬럼만 생성
- Ollama chat 모델은 `qwen2.5:3b` 사용. 외부 API(Claude/GPT) 연동은 Spec 4로 미룸
- license_key 테이블은 스키마에 유지하되 Spec 1에서는 미사용 (Spec 4에서 외부 API 연동 시 활성화)
- 토론 모드 UI는 Spec 2 이후로 미룸 — LLM 인터페이스만 멀티모델 대응으로 설계
- clustering 컨테이너는 Docker Compose에 포함하되 Spec 2까지 미사용
- `updated_at` 자동 갱신: `set_updated_at` 함수 1개 생성 후 해당 컬럼이 있는 각 테이블마다 트리거 개별 등록
- LLM 모델 버전은 common_code(`model`)로 관리. 호출 버전은 API 응답에서 받아 `message.model`에 저장. model → parent → provider 역참조로 provider 식별
- DB 전체 암호화(encryption at rest)는 Spec 4 배포 시 검토
