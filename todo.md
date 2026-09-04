# TODO

## 즉시 처리 필요 (2026-08-06 Ollama 임베딩 버그 후속)

- [x] DB 정리: `b5a40088-f206-4301-85d2-9b6e6ee1631c`(구직 내용, Ollama race condition 버그로 RAG memory에 잘못 merge된 version 2) 삭제 + `d6dcf2c4-95b4-4175-b184-b3b5940c012b`를 `is_active=true`로 복구
- [x] job-search 원본 메시지 4개(`72226caf`, `d42e6732`, `5c75e7ce`, `da842acd`) `is_proceeded=false`로 리셋 후 재처리 — 이번엔 별도 memory로 제대로 분리되는지 확인
- [ ] main memory 승격 테스트 — knowledge memory 2개 이상 확보되면 `scheduler.manual.spec.ts`로 `updateMainMemory` 실행
- [ ] chat 시 시스템 프롬프트에 main memory, 최근 history(exchange 단위)가 실제로 잘 들어가는지 테스트
- [ ] `scheduler.manual.spec.ts`의 `jest.setTimeout(0)` 버그 수정 — jest-circus에서 0은 "무제한"이 아니라 즉시 timeout으로 처리됨(`test.timeout || state.testTimeout` 에서 0이 falsy가 아니라 그대로 setTimeout(fn, 0)으로 들어감). 충분히 큰 값(예: 600000)으로 교체 필요
- [x] `scheduler.service.ts:59` `parseRowsToExchange`의 `row.role === 'user'` 시딩 — `message.repository.ts` `findUnprocessedExchanges`를 INNER JOIN → LEFT JOIN(message 기준)으로 교체, user row도 COALESCE(mc.content, m.content)/COALESCE(mc.weight, 1)로 포함되게 수정
- [x] `scheduler.service.ts:99-100` `for (const id in exchanges)` / `exchanges[id]` — `for (const [id, exchange] of exchanges)`로 교체
- [x] `scheduler.service.ts:184` `checkMessageFromMemory`의 `centroid` — 쿼리용(`queryCentroid`, `search_query:`)과 저장용(`centroid`, `search_document:`)을 분리해서 각각 embed하도록 수정

## 컨벤션 전체 반영 필요

- [ ] DTO 이름에 `Request`/`Response` 접미사 규칙(CLAUDE.md 추가됨, 2026-08-21) — 기존 controller DTO들 전체 리네임 필요, 아직 반영 안 함

## DB 스키마

- [ ] `message.embedding` 컬럼 drop — message_content.embedding centroid로 대체됨. 테스트 후 마이그레이션.

## 다음 작업

- [ ] `analyzeConversation` 결과가 대화는 한국어인데도 영문으로 나오는 문제 — 프롬프트에 언어 지침 강하게 넣어봤는데도 재현됨(모델이 지침 무시). 원인/해결 방향 재검토 필요
- [ ] memorization 시 전체 메시지 대상 clustering 방식 재검토 — 지금은 summary로 clustering 테스트 중, 제대로 된 방법 찾아야 함
  - 아이디어: `prepareGroup`의 `clusterCentroid`를 매번 새로 LLM 요약(`generateMessageContents`) + 재임베딩하는 대신, 이미 `message_content`(chat 실시간 경로에서 LLM이 한 번 처리한 문장들)의 weighted centroid를 `search_query:` prefix로 재사용 — 어차피 raw 대화 아니라 한 번 처리된 content라 "요약 vs 요약" 비교 성립할 수도 있음. 테스트해볼 가치 있음(정확도 비교 필요)

## 향후 Spec 후보

- [ ] 삭제된 knowledge memory의 근거 message 재생성 — Spec 3 결정 B: 삭제 시 재처리 안 함(`root_memory_id`만 NULL). 나중에 유저가 삭제한 memory를 다시 생성하고 싶어할 경우 별도 기능 필요
- [ ] keyword 수동 편집 — Spec 3 Task 4(knowledge memory 수동 편집)에서 keyword는 편집 대상에서 제외, 기존 값 그대로 carry만 함. 유저가 keyword를 직접 추가/삭제하고 싶어할 경우 UI/API 설계 필요
- [ ] 시스템 내부(배치 분석/main memory 합성 등) 모델 선택 가능하게 — 지금은 기본 exaone(로컬)으로 고정. API 모델이든 다른 로컬 모델이든 고를 수 있게 설정 필요
- [ ] 키워드 대시보드 프론트(`/keywords` 페이지, `HeaderNav` 링크, 배지 클릭 시 필터된 memory 목록 이동) — Spec 3 Task 6은 백엔드 API(`GET /memory/keywords`, `GET /memory/keywords/:code/memories`)까지만. 클릭 이동 시 별도 엔드포인트로 갈지 `GET /memory/knowledge`에 옵션 필터 넣어 통합할지도 그때 같이 결정
- [ ] main memory 갱신 스케줄러를 message→knowledge memory 배치(`checkAndRun`)에서 분리 — 지금은 한 cron 안에서 순차 실행(현재 주석처리 상태로 미작동). 독립된 동작이라 각자 다른 주기로 돌아야 함(예: main memory는 별도 configurable interval, `SCHEDULER_BATCH_INTERVAL_HOURS`처럼 `.env`로 설정). Spec 3 Task 10에서 트리거 개념은 없앴지만(`updateMainMemory`가 항상 topN+pinned로 무조건 재생성) 실제 cron 분리/주기 설정은 아직 반영 안 됨
- [ ] `memory_content.is_user_defined` 필드 추가 — 유저가 직접 작성/수정한 문장은 시스템(LLM merge/renewal)이 건드리지 못하게 보호. 지금은 merge 시 LLM이 기존 content 전체를 다시 합성하기 때문에, 수동 편집(`history_type='modified'`)한 내용도 다음 배치에서 LLM이 재해석하면서 유실/변형될 수 있음(실제로 구멍 있음, 확인 필요).
  - 구현 방향: merge 시 `is_user_defined=true` 문장은 LLM 재생성 대상에서 제외하고, LLM이 새로 만든 문장들과 무조건 union — LLM한테 "이 문장 그대로 둬"라고 지시만 하는 방식은 신뢰 못 함(LLM이 원문 그대로 재현한다는 보장 없음)
  - 후속 컨셉(트리거 조건 미정): 배치 결과 해당 memory의 content가 전부 `is_user_defined`뿐이면(=시스템이 더 이상 기여할 게 없는 상태) 유저에게 확인시키고 삭제 여부 결정 — 구체적으로 언제/어떻게 감지·알림할지는 미정, 프론트 UI도 필요(Spec 4+ 범위로 추정)
