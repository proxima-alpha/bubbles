# Research — 코드베이스 현황

_Spec 2 시작 시점 기준_

---

## 모듈 구조 (backend)

```
src/
├── auth/          register, login (JWT cookie)
├── chat/          POST /chat/stream (SSE), GET /chat/history
├── user/          GET /user, PUT /user, PUT /user/model
├── model/
│   ├── model.service.ts      getModelInfo(), chatStream()
│   └── providers/
│       └── ollama.provider.ts  chatStream() — Ollama /api/chat (stream: true)
├── prisma/        PrismaService
└── app.module.ts
```

## DB 스키마 요약

| 테이블 | 주요 상태 |
|--------|-----------|
| `common_code_category` | role, provider, model, memory_type, memory_history_type |
| `common_code` | user/assistant, ollama, exaone3.5:2.4b, main/knowledge, created/renewed/uploaded/modified |
| `user` | id, email, model (nullable) |
| `message` | content, embedding(`vector(768)`, 미사용), is_proceeded(false 고정), role, provider, model |
| `memory` | type(main/knowledge), keywords[], version, is_pinned, is_active — **score 관련 컬럼 없음** |
| `memory_content` | memory당 content 청크 (order 있음) |
| `memory_content__message` | memory_content ↔ message 연결 (Spec 2에서 채움) |
| `license_key` | Spec 4까지 미사용 |

## 현재 chat.service.ts 동작

1. user.model null 체크
2. user message DB 저장
3. 최근 20개 messages 조회 → LLM 컨텍스트로 전달
4. Ollama chatStream → SSE 토큰 전송
5. assistant message DB 저장 (embedding 미생성)
6. `[DONE]` 전송

## 미구현 / 미연동 항목

- `message.embedding` — 컬럼만 존재, 값 없음
- `message.is_proceeded` — 항상 false
- `memory` 테이블 — 레코드 없음
- clustering/main.py — stub only (`"status": "not_implemented"`)
- 시스템 프롬프트 — 없음 (LLM에 raw messages만 전달)
- RAG 컨텍스트 조립 — 없음

## 인프라

- `ollama-init`: `nomic-embed-text` + `exaone3.5:2.4b` 자동 pull
- `clustering` 컨테이너: Python stdin/stdout 방식, 현재 stub
- pgvector 확장: DB에 이미 활성화됨

## 주요 의존성

```
backend: @nestjs/schedule (미설치), @prisma/client (pgvector unsupported 타입)
python: hdbscan, numpy, scikit-learn (미설치)
```
