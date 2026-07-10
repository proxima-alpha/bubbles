# Feed-005: Memory 갤러리 뷰 + 상세 페이지 (history, 근거 메시지)

## 목적

Spec-002 Task(8)에서 만든 `/memory` 리스트 뷰를 Notion gallery view 스타일 그리드로 바꾸고,
카드 클릭 시 상세 페이지에서 버전 history를 카드 캐러셀로 탐색하고, content 문장 클릭 시 근거 메시지를 볼 수 있게 한다.

---

## 결정 사항

| # | 항목 | 결정 |
|---|------|------|
| A | 상단 네비 위치 | 직접 노출 링크는 `채팅`/`메모리`만. `프로필`/`로그아웃`은 우측 상단 버튼(⋮) 클릭 시 나타나는 드롭다운 리스트로 이동. 공통 `HeaderNav` 컴포넌트로 추출해 `chat`, `memory` 페이지에서 재사용 (`profile` 페이지는 기존 back-link 헤더 유지, 이번 범위 밖) |
| B | 그리드 컬럼 | `grid-cols-2 md:grid-cols-3` |
| C | history 캐러셀 구현 | `embla-carousel-react` 설치해 드래그/스와이프 캐러셀 구현 (경량, MIT 라이선스) |
| D | "서치" 해석 | 텍스트 검색 아님 — 스와이프/드래그로 버전 탐색을 의미하는 것으로 해석 |
| E | 근거 메시지 표시 | 모달 대신 클릭한 content 줄 바로 아래에 inline expand |
| F | history 정렬 | `version DESC` (최신이 첫 카드, 스와이프하면 과거 버전) |

---

## Task 1 — 공통 `HeaderNav` 컴포넌트 도입

`chat/page.tsx`, `memory/page.tsx`가 동일한 "Bubbles 타이틀 + 우측 네비" 헤더를 쓰므로 `components/header-nav.tsx`로 추출.

- 직접 노출 링크: `채팅`, `메모리`
- `⋮` 버튼 클릭 시 드롭다운으로 `프로필` 링크 + `로그아웃` 버튼 노출 (로그아웃 로직은 기존 `chat/page.tsx`의 `handleLogout` 그대로 이동)
- `chat/page.tsx`, `memory/page.tsx`의 기존 `<header>` 블록을 `<HeaderNav />`로 교체, `chat/page.tsx`의 `handleLogout`은 제거 (orphan)

---

## Task 2 — `GET /memory/knowledge` 응답에 `contents` 추가

### `memory.repository.ts`

```typescript
async getKnowledgeList(userId: string) {
  return this.prisma.memory.findMany({
    where: { user_id: userId, type: 'knowledge', is_active: true },
    orderBy: { created_at: 'desc' },
    include: {
      keywords: { include: { keyword: true } },
      contents: true,
    },
  });
}
```

### `memory.service.ts`

공통 포맷터로 분리 (Task 3에서 재사용):

```typescript
private formatKnowledge(m: KnowledgeMemoryWithRelations) {
  return {
    id: m.id,
    keywords: m.keywords.map(mk => ({ code: mk.keyword_code, name: mk.keyword.name })),
    contents: m.contents.map(c => ({ id: c.id, content: c.content })),
    version: m.version,
    isPinned: m.is_pinned,
    createdAt: m.created_at,
  };
}

async getKnowledgeList(userId: string) {
  const memories = await this.memoryRepo.getKnowledgeList(userId);
  return memories.map(m => this.formatKnowledge(m));
}
```

응답 예시:
```json
[{
  "id": "uuid",
  "keywords": [{"code": "rag-technique", "name": "RAG 기법"}],
  "contents": [{"id": "uuid", "content": "..."}],
  "version": 2,
  "isPinned": false,
  "createdAt": "2026-07-01T00:00:00Z"
}]
```

---

## Task 3 — 상세 조회 + history API

### `memory.repository.ts`

```typescript
async findKnowledgeMemory(userId: string, id: string) {
  return this.prisma.memory.findFirst({
    where: { id, user_id: userId, type: 'knowledge' },
    include: { keywords: { include: { keyword: true } }, contents: true },
  });
}

async findMemoryHistory(userId: string, id: string) {
  const target = await this.prisma.memory.findFirst({
    where: { id, user_id: userId, type: 'knowledge' },
    select: { id: true, root_memory_id: true },
  });
  if (!target) return [];
  const rootId = target.root_memory_id ?? target.id;

  return this.prisma.memory.findMany({
    where: { user_id: userId, type: 'knowledge', OR: [{ id: rootId }, { root_memory_id: rootId }] },
    orderBy: { version: 'desc' },
    include: { keywords: { include: { keyword: true } }, contents: true },
  });
}
```

### `memory.service.ts` / `memory.controller.ts`

`getKnowledgeDetail`/`getKnowledgeHistory`가 각각 repository 결과를 `formatKnowledge`로 변환해 반환. `GET /memory/knowledge/:id`, `GET /memory/knowledge/:id/history`로 노출.

---

## Task 4 — 근거 메시지 API

`memory_content__message`로 연결된 원본 메시지 조회. `memory` join으로 소유권(`user_id`) 검증 — 다른 유저의 memory_content_id를 넘겨도 조회되지 않도록.

### `memory.repository.ts`

```typescript
async findContentMessages(userId: string, contentId: string) {
  return this.prisma.$queryRaw<{ id: string; role: string; provider: string | null; content: string; created_at: Date }[]>`
    SELECT m.id, m.role, m.provider, m.content, m.created_at
    FROM memory_content__message mcm
    JOIN message m ON m.id = mcm.message_id
    JOIN memory_content mc ON mc.id = mcm.memory_content_id
    JOIN memory mem ON mem.id = mc.memory_id
    WHERE mcm.memory_content_id = ${contentId}::uuid
      AND mem.user_id = ${userId}::uuid
    ORDER BY m.created_at ASC
  `;
}
```

### `memory.service.ts` / `memory.controller.ts`

`getContentMessages(userId, contentId)`가 repository를 그대로 통과시키고, `GET /memory/content/:id/messages`로 노출.

---

## Task 5 — 프론트: `/memory` 그리드 뷰

- `memory/page.tsx`의 `space-y-3` 세로 리스트 → `grid-cols-2 md:grid-cols-3` 그리드로 교체
- 카드: 상단에 `contents` 최대 5개 미리보기(불릿), 하단에 keyword 배지. 카드 클릭 시 `/memory/[id]`로 이동
- `KnowledgeMemory` 인터페이스에 `contents: { id: string; content: string }[]` 추가

---

## Task 6 — 프론트: `/memory/[id]` 상세 페이지 (신규)

- `GET /memory/knowledge/:id/history`로 버전 목록(최신 먼저) 조회 → `embla-carousel-react`(`useEmblaCarousel({ align: 'center' })`)로 드래그 캐러셀 렌더링
- 설치: `cd apps/frontend && pnpm add embla-carousel-react`
- 각 카드 안에서 content 줄 클릭 시 `GET /memory/content/:contentId/messages` 호출, 클릭한 줄 바로 아래에 근거 메시지 inline expand (React Query `enabled: open`으로 클릭 시에만 fetch)

---

## Task 7 — `HeaderNav` 레이아웃: sticky + 너비

- `sticky top-0 z-10` 적용 — 아래로 스크롤해도 헤더가 고정되도록
- 좌측: "Bubbles" 타이틀 바로 옆에 `채팅`/`메모리` 링크 (가운데 정렬 아님, 왼쪽으로 그룹핑)
- 우측: `⋮` 드롭다운 (프로필/로그아웃)
- 헤더 안쪽 컨텐츠 너비는 `max-w-4xl` — 본문(`chat`/`memory`의 `<main>`, `max-w-2xl`)보다 의도적으로 넓게 유지, 정렬은 맞추지 않음

---

## 영향 범위

- `components/header-nav.tsx` — 신규, 공통 헤더(채팅/메모리 링크 + 프로필/로그아웃 드롭다운)
- `chat/page.tsx` — `<HeaderNav />` 사용, 기존 `handleLogout`/헤더 마크업 제거
- `memory/page.tsx` — `<HeaderNav />` 사용, 그리드 뷰로 변경, `contents` 필드 추가
- `memory.repository.ts` — `getKnowledgeList`에 `contents` include 추가, `findKnowledgeMemory`/`findMemoryHistory`/`findContentMessages` 추가
- `memory.service.ts` — `formatKnowledge` 공통 포맷터 추출, `getKnowledgeDetail`/`getKnowledgeHistory`/`getContentMessages` 추가
- `memory.controller.ts` — `GET /memory/knowledge/:id`, `GET /memory/knowledge/:id/history`, `GET /memory/content/:id/messages` 추가
- `memory/[id]/page.tsx` — 신규, `embla-carousel-react` 기반 history 캐러셀 + 근거 메시지 expand
- `apps/frontend/package.json` — `embla-carousel-react` 의존성 추가

---

## 태스크

- [x] T1. `components/header-nav.tsx` 신규 + `chat/page.tsx`, `memory/page.tsx`에서 사용
- [x] T2. `memory.repository.ts` / `memory.service.ts` — `getKnowledgeList`에 `contents` 추가, `formatKnowledge` 추출
- [x] T3. `memory.repository.ts` / `memory.service.ts` / `memory.controller.ts` — 단건 상세 + history API 추가
- [x] T4. `memory.repository.ts` / `memory.service.ts` / `memory.controller.ts` — 근거 메시지 API 추가
- [x] T5. `memory/page.tsx` — 그리드 뷰로 변경
- [x] T6. `embla-carousel-react` 설치 + `memory/[id]/page.tsx` — 상세 페이지 신규 (history 캐러셀 + content 클릭 → 근거 메시지)
- [x] T7. `components/header-nav.tsx` — 3-column 레이아웃(가운데 정렬) + `sticky` 헤더
