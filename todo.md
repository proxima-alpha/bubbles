# TODO

## DB 스키마

- [ ] `message.embedding` 컬럼 drop — message_content.embedding centroid로 대체됨. 테스트 후 마이그레이션.

## 향후 Spec 후보

- [ ] 삭제된 knowledge memory의 근거 message 재생성 — Spec 3 결정 B: 삭제 시 재처리 안 함(`root_memory_id`만 NULL). 나중에 유저가 삭제한 memory를 다시 생성하고 싶어할 경우 별도 기능 필요
- [ ] keyword 수동 편집 — Spec 3 Task 4(knowledge memory 수동 편집)에서 keyword는 편집 대상에서 제외, 기존 값 그대로 carry만 함. 유저가 keyword를 직접 추가/삭제하고 싶어할 경우 UI/API 설계 필요
- [ ] 시스템 내부(배치 분석/main memory 합성 등) 모델 선택 가능하게 — 지금은 기본 exaone(로컬)으로 고정. API 모델이든 다른 로컬 모델이든 고를 수 있게 설정 필요
- [ ] 키워드 대시보드 프론트(`/keywords` 페이지, `HeaderNav` 링크, 배지 클릭 시 필터된 memory 목록 이동) — Spec 3 Task 6은 백엔드 API(`GET /memory/keywords`, `GET /memory/keywords/:code/memories`)까지만. 클릭 이동 시 별도 엔드포인트로 갈지 `GET /memory/knowledge`에 옵션 필터 넣어 통합할지도 그때 같이 결정
