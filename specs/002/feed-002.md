# Spec 002 — Feed 002: memory_content 구조 재설계

## 배경

기존 구현에서 `memory_content`가 LLM이 임의로 재생성한 텍스트 청크를 저장하고 있어 role/provider 정보가 유실되고, `memory_content__message` attribution도 firstContent에만 전체 메시지를 연결하는 버그가 있었음.

---

## 결정 사항

### 1. memory_content 의미 재정의

- `memory` = LLM이 생성한 요약 문단 전체
- `memory_content` = 그 문단을 구성하는 각 문장 (LLM이 배열로 반환)
- `memory_content__message` = 각 문장이 어떤 원본 메시지에서 유래했는지 (N:M 귀속)
- **불변 조건**: `memory_content` 1행은 반드시 1개 이상의 message와 연결 (근거 없는 문장 금지)
- `memory.content` = `memory_content` 문장들을 `\n`으로 join한 전체 텍스트

### 2. memory_content 스키마 변경

`order` 컬럼 제거 — 순서는 `created_at` 또는 배열 index로 충분.

### 3. message.parent_message_id 추가

assistant 메시지가 어떤 user 질문에 대한 응답인지 DB 레벨에서 추적.
`chat.service.ts`에서 assistant 메시지 저장 시 `parent_message_id = userMsg.id` 설정.

### 4. LLM 입력 포맷 변경

기존 flat 텍스트 join → role/provider + message_id 포함 배열:

```json
[
  {"user":   {"text": "파이썬 list comprehension이 뭐야?", "message_id": "uuid-a"}},
  {"ollama": {"text": "[x*2 for x in lst] 이렇게 쓰면 돼",  "message_id": "uuid-b"}}
]
```

- key가 `"user"`이면 이용자 질문, 그 외는 AI 제공자명
- user 메시지는 LLM 컨텍스트용으로만 포함 — `association` 출력에서 user message_id 제외
- merge 케이스: 기존 `memory.content` 문장들을 앞에 추가 (`message_id` 없음), 새 messages만 association 대상

### 5. LLM 출력 포맷 변경

`contents: [{order, text}]` → `contents: string[]` + `association: string[][]`

```json
{
  "contents": ["문장1", "문장2"],
  "association": [
    ["uuid-b"],
    ["uuid-b"]
  ],
  ...
}
```

- `contents[i]`와 `association[i]`는 같은 index로 대응
- `association[i]`가 비어있거나 없는 `contents[i]`는 저장하지 않음
- `association[i]`의 message_id → `memory_content__message` 생성

---

## 구현 대상

- [ ] DB 마이그레이션: `message.parent_message_id` 추가, `memory_content.order` 제거
- [ ] `chat.service.ts`: assistant 저장 시 `parent_message_id` 설정
- [ ] `scheduler.service.ts`: LLM 입력/출력 포맷 변경, association 기반 memory_content__message 생성
- [ ] `LlmMemoryAnalysis` 인터페이스 업데이트
