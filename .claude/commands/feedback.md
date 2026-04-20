`plan.md` 및 `plans/*.md`의 인라인 주석 `[//]: # (...)` 을 스캔하여 피드백을 반영한다.

- `$ARGUMENTS`가 있으면 해당 phase 파일만 대상. 다음 세 형식 모두 허용:
  - `phase-001` → `plans/phase-001.md`
  - `001` → `plans/phase-001.md`
  - `1` → `plans/phase-001.md`
- `$ARGUMENTS`가 없으면 `plan.md` + `plans/*.md` 전체 대상
- 반영 후 주석은 삭제
- 확신이 75% 미만이면 반영 전에 되묻기, 이상이면 바로 반영
