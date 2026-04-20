확정된 plan을 기반으로 코드를 작성한다.

- `$ARGUMENTS`가 있으면 해당 phase 대상. 다음 세 형식 모두 허용:
  - `phase-001` → `plans/phase-001.md`
  - `001` → `plans/phase-001.md`
  - `1` → `plans/phase-001.md`
- `$ARGUMENTS`가 없으면 현재 진행 중인 phase 대상
- 실행 전 반영되지 않은 주석 `[//]: # (...)` 이 남아있으면 먼저 `/feedback` 실행 후 진행
- 워크플로우 4단계(코드 작성)에 해당 — 유저의 명시적 호출 없이 단독 실행 금지
