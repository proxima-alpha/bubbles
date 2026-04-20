변경된 파일을 git add → commit → push 한다.

- `$ARGUMENTS`가 있으면 커밋 메시지로 사용 (예: `/confirm Feat: 채팅 UI 추가`)
- `$ARGUMENTS`가 없으면 변경 내용을 파악하여 적절한 커밋 메시지 자동 생성
- 커밋 메시지는 CLAUDE.md의 커밋 규칙(Commit Keywords)을 따를 것
- 브랜치 확인 없이 현재 브랜치로 바로 push (개인 프로젝트 — 협업 시 이 규칙 재검토 필요)
