`plan.md` 및 `specs/*.md`의 인라인 주석 `[//]: # (...)` 을 스캔하여 피드백을 반영한다.

- `$ARGUMENTS`가 있으면 해당 파일만 대상. 다음 형식 모두 허용:
  - `plan` → `plan.md`
  - `spec-001` → `specs/spec-001.md`
  - `spec-001-002` → `specs/spec-001-002.md` (서브스펙)
  - `001` → `specs/spec-001.md`
  - `001-002` → `specs/spec-001-002.md`
  - `1` → `specs/spec-001.md`
- `$ARGUMENTS`가 없으면 `plan.md` + `specs/*.md` 전체 대상
- 반영 후 주석은 삭제
- 확신이 75% 미만이면 반영 전에 되묻기, 이상이면 바로 반영
