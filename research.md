# Research — 코드베이스 현황

_Spec 3 시작 시점 기준_

---

## 모듈 구조 (backend)

```
src/
├── auth/          register, login (JWT cookie)
├── chat/          POST /chat/stream (SSE), GET /chat/history
├── user/          GET /user, PUT /user, PUT /user/model
├── model/
│   ├── model.service.ts      getModelInfo(), chatStream(), embedText()
│   └── providers/
│       └── ollama.provider.ts  chatStream(), embed()
├── memory/
│   ├── memory.controller.ts   GET /memory/knowledge, /knowledge/:id, /knowledge/:id/history, /content/:id/messages
│   ├── memory.service.ts      getActiveMainMemory(), getTopKnowledge(), getKnowledgeList/Detail/History(), getContentMessages(), formatKnowledge()
│   ├── memory.repository.ts   DB 접근 전체 (findSimilarMemory, saveMemory, findMemoryMessages, getKnowledgeList 등)
│   ├── scheduler.service.ts   @Cron('* * * * *') checkAndRun → executeMemorization (클러스터링 → merge/생성 → main memory 갱신)
│   └── decay.scheduler.ts     매일 00:00 UTC repetition_strength 감쇠
├── prisma/        PrismaService
└── app.module.ts
```

**MemoryModule에 아직 없는 것** (Spec 3 대상):
- pin/삭제/수동 편집 API — 전혀 없음 (읽기 전용)
- main memory 조회/편집 API — 없음 (스케줄러 내부에서만 갱신, 외부 노출 없음)
- 키워드 대시보드/집계 API — 없음
- import/export — 없음
- 망각(score 기반 자동 정리) — 없음. `decay.scheduler.ts`는 `repetition_strength` 감쇠만 함

## DB 스키마 요약 (Spec 2에서 채워진 상태)

| 테이블 | 비고 |
|--------|------|
| `memory` | `type`(main/knowledge), `score`/`sensitivity`/`importance` 등 점수 컴포넌트, `is_pinned`, `is_active`, `root_memory_id`/`parent_memory_id`(버전 체인), `content`(클러스터링용 원문), `summary`(RAG 주입용 LLM 요약) |
| `memory_content` | memory 1개 버전의 문장 단위 분해. `memory_content__message`로 근거 message N:M |
| `keyword` / `memory__keyword` | `code` PK, `memory__keyword`는 특정 버전(memory_id, 해당 시점 id)에 연결 — **버전마다 다시 계산됨, 과거 버전 링크가 자동으로 안 넘어옴** |
| `message` | `root_memory_id`(FK → memory.id) — 그 message가 근거로 쓰인 memory lineage의 root id. `embedding`, `is_proceeded` |
| `schedule` | `memory_batch` 타입 1개, 마지막 배치 시각 추적 |

`memory` 삭제/soft-delete 컬럼 없음 (`is_active`만 있고, 이건 "renewed로 대체됨" 의미로 이미 사용 중 — 유저가 명시적으로 지운 것과 구분 안 됨). Spec 3에서 삭제 의미 설계 필요.

## 현재 RAG 컨텍스트 조립 (chat.service.ts, Spec 2 완료)

1. user message 저장 + 동기 임베딩(실패 시 503)
2. `memoryService.getActiveMainMemory(userId)` + `getTopKnowledge(userId, embedding, RAG_TOP_K)`
3. 시스템 프롬프트 조립 → Ollama 스트림 호출
4. assistant message 저장 + 비동기 임베딩

## Frontend 구조

```
src/app/
├── (auth)/login, register
├── chat/page.tsx          채팅 UI
├── memory/page.tsx         지식 메모리 그리드 (읽기 전용, 편집/삭제/pin UI 없음)
├── memory/[id]/page.tsx    버전 history 캐러셀 (embla-carousel-react) + 근거 메시지 inline expand
└── profile/page.tsx

src/components/
├── header-nav.tsx    공통 헤더 (채팅/메모리 링크 + 프로필/로그아웃 드롭다운) — 키워드 대시보드 라우트 추가 시 여기 링크 추가
└── markdown-content.tsx
```

- `lib/api.ts` — axios 인스턴스, 401 시 `/login` 리다이렉트
- React Query 사용 패턴: `useQuery({ queryKey, queryFn: () => api.get(...).then(r => r.data) })`

## 인프라 / 마이그레이션

- 최신 마이그레이션: `20260728065302_add_message_root_memory_id`
- pgvector 활성화됨, clustering 컨테이너(FastAPI) 정상 동작 중
