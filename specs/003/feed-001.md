# Spec-003 Feedback — message_content weighted centroid

## 배경

`executeMemorization`에서 `message_content` 임베딩으로 centroid 계산할 때 문장별 중요도 반영이 안 됨(단순 평균). 문장별 weight를 둬서 weighted centroid로 바꾸고 싶음.

## 결정 사항

| # | 항목 | 결정 |
|---|------|------|
| 1 | weight 출처 | LLM이 `contents` 생성 시 문장별로 0~1 weight를 직접 부여 |
| 2 | contents 타입 | `string[]` → `{text, weight}[]` |
| 3 | 적용 범위 | 우선 `generateMessageContent`(단건, `chat.service.ts` 실시간 대화 경로)만 변경 → 결과 괜찮으면 memory 전체 파이프라인(`analyzeConversation` 등 batch 경로, `embedTexts` weighted 확장)으로 넓힘 (테스트는 유저 직접 진행) |

## 구현 대상

- [x] T1. DB 마이그레이션 — `message_content.weight` 추가

```prisma
model message_content {
  // 기존 컬럼 유지 ...
  weight Float @default(1)
}
```

`prisma/migrations/20260820094615_add_message_content_weight/migration.sql` 작성 완료. **아직 `prisma migrate deploy` 미실행 — DB 미반영 상태.**

- [x] T2. `system-chat.service.ts` — `generateMessageContent` 응답 schema/prompt를 `{text, weight}[]`로 변경

- [x] T3. `chat.service.ts` — `generateMessageContent`(단수, 실시간 경로) 리턴 타입이 `{text,weight}[]`로 바뀐 데 맞춰 `contents` 어댑팅. embedding은 `contents.map(c => c.text)`로 text만 뽑아 생성, weight는 `insertMessageContents` 호출 시 같이 전달

- [x] T4. `message.repository.ts` — `insertMessageContents` 시그니처에 `weight` 추가, INSERT문에 `message_content.weight` 컬럼 반영

## T6. 클러스터링 vector를 weighted centroid로 교체 (완료)

**변경 파일**
- `message.repository.ts`
  - `Exchange`에 `contentWeights: number[]` 추가 (contentEmbeddings와 parallel)
  - `findUnprocessedExchanges` 쿼리에 `mc.weight` SELECT 추가, `contentWeightsByMsgId` map으로 수집해 반환값에 포함
- `scheduler.service.ts`
  - `executeMemorization`의 다중 exchange 분기(`exchanges.length > 1`)에서 `exchangeTexts` 조립 + `modelService.embedTexts(...)` 재임베딩 호출 제거
  - 대신 `exchanges.map(e => this.modelService.getWeightedCentroid(e.contentEmbeddings, e.contentWeights))`로 클러스터링 input vector 생성

**빈 message_content 처리 관련 재확인**
- `findUnprocessedExchanges`가 `message_content mc JOIN message m` (INNER JOIN) 이라 message_content 없는 assistant message는 애초에 결과에 안 나옴 → exchange의 `contentEmbeddings`/`contentWeights`가 빈 배열로 들어올 일 없음. "제외 vs fallback" 결정 불필요해짐.

**미검증**
- `getWeightedCentroid`의 totalWeight===0 fallback 케이스, 실제 LLM weight 분포로 클러스터링 품질 변화 — 아직 안 봄 (테스트는 유저 직접 진행)

## T7. centroid 계산 로직을 model.service.ts로 이동 + 네이밍 통일 (완료)

유저 피드백: weightedCentroid는 처음부터 model.service.ts에 있었어야 했고, 기존 것과 이름도 통일했어야 함. 함수명 verb-first 컨벤션도 지켜야 함 → CLAUDE.md에 규칙 추가.

**변경 파일**
- `model.service.ts`
  - `private averageVectors` → `getAverageCentroid`(public)로 이름 변경, `vectors.length === 0` 가드 추가(기존엔 없어서 빈 배열 들어오면 `vectors[0]` undefined로 터졌을 것 — scheduler 쪽 호출부는 빈 배열 들어올 수 있어서 필요)
  - `getWeightedCentroid(vectors, weights)` 신규 추가 (scheduler.service.ts에 있던 것 이동)
- `scheduler.service.ts`
  - 로컬 `centroid()`, `weightedCentroid()` 함수 삭제
  - 호출부 3곳(`consolidateByTarget`, `prepareGroup`, `executeMemorization`) 전부 `this.modelService.getAverageCentroid(...)` / `this.modelService.getWeightedCentroid(...)`로 교체
- `CLAUDE.md` (프로젝트 루트) — "함수명은 동사로 시작" 규칙 + "벡터/임베딩 연산은 model.service.ts에 모을 것" 추가

**남은 중복 → 제거함**
- `memory.repository.ts:50`의 dead `centroid()` 삭제함 (호출부 없었음)

## T8. findUnprocessedExchanges의 parallel map 3개를 object array 하나로 통합 (완료)

유저 피드백: `contentTextByMsgId`/`contentEmbeddingsByMsgId`/`contentWeightsByMsgId` 3개 Map을 index로 맞춰 관리할 이유 없음 — `Map<string, {content, embedding, weight}[]>` 하나면 됨. 백엔드 전체 grep해서 비슷한 parallel map/array 패턴 있는지 확인함 — 이 함수가 유일한 케이스였음.

**변경 파일**
- `message.repository.ts`
  - 3개 Map → `contentsByMsgId: Map<string, {content, embedding, weight}[]>` 하나로 통합
  - 리턴부에서 `contents.map(c => c.content).join('\n')` / `contents.map(c => c.embedding)` / `contents.map(c => c.weight)`로 필요한 필드만 뽑아 사용

## T9. 클러스터링 벡터에 user 질문 다시 합류 (완료)

**버그 발견 경위**: T6에서 raw exchange text 재임베딩(`embedTexts`)을 `message_content` 기반 weighted centroid로 바꾸면서, 원래 `e.messages`(질문+응답 합쳐서) 기준이던 게 `e.contentEmbeddings`(assistant 요약 문장만) 기준으로 바뀜 → user 질문 텍스트가 클러스터링 벡터에서 통째로 빠지는 회귀 생김. 유저가 지적해서 발견.

**결정**: 질문도 다시 합류. weight는 1로 고정 (LLM이 매기는 assistant 문장 weight와 달리 질문은 항상 동일 비중).

**변경 파일**
- `scheduler.service.ts` — `executeMemorization`의 다중 exchange 분기
  - `exchanges.map(e => e.messages.find(m => m.role === 'user')?.content)`로 질문 텍스트 추출 (parent 없는 exchange는 `undefined`)
  - 질문 있는 것만 모아서 `modelService.embedTexts(..., 'clustering: ')`로 배치 임베딩 (질문 없는 exchange는 스킵, 재임베딩 대상에서 제외)
  - 각 exchange마다 `[...contentEmbeddings, questionEmbedding]` / `[...contentWeights, 1]`로 합쳐서 `getWeightedCentroid` 호출. 질문 없으면 기존 `contentEmbeddings`/`contentWeights`만 사용

**미검증**
- parent_message_id 없는 assistant exchange가 실제로 존재하는지(스키마상 nullable이라 코드는 방어했지만 실제 발생 케이스는 확인 안 함)

## T10. message_content.id DB default 누락 수정 (완료)

유저 지적: `insertMessageContents`의 raw INSERT에 `gen_random_uuid()`를 직접 넣고 있던 거 — 원인 파보니 `20260626000000_sync_message_content_drift` migration이 `message_content` 테이블 만들 때 다른 테이블들과 달리 `id DEFAULT gen_random_uuid()`를 빠뜨렸음(schema.prisma엔 `@default(uuid())` 있는데 DB엔 없었음). 그래서 raw SQL에서 수동으로 채워야 했던 것.

**변경 파일**
- `prisma/migrations/20260821000000_message_content_id_default/migration.sql` (신규) — `ALTER TABLE message_content ALTER COLUMN id SET DEFAULT gen_random_uuid()`
- `message.repository.ts` — `insertMessageContents` INSERT문에서 `id`, `gen_random_uuid()` 제거 (컬럼 리스트: `message_id, seq, content, embedding, weight`만)

**미실행**
- 새 migration `prisma migrate deploy` 아직 안 돌림 (기존 weight migration도 마찬가지로 미실행 상태, T1 참고)

## T11. gen_random_uuid() → uuid_generate_v7()로 전체 테이블 전환 (완료)

유저 지시: T10에서 그냥 `gen_random_uuid()`(v4) default로 고친 게 마음에 안 듦 — UUID v7로 가야 함. 방식은 "DB extension 설치", 범위는 "전체 테이블"로 확정.

pg16엔 네이티브 `uuidv7()` 없음(PG18+). `pg_uuidv7`(fboulnois) extension 사용.

**변경 파일**
- `db/Dockerfile` (신규) — `pgvector/pgvector:pg16` 베이스에 `pg_uuidv7` 소스 빌드해서 설치
  - 처음엔 GitHub release의 prebuilt tarball(`pg_uuidv7.tar.gz`) 방식 시도했는데 **x86-64 전용 바이너리라 arm64(Mac) 개발 환경에서 로드 실패**(`could not load library`) — 소스 빌드(`git clone v1.7.0` + `make` + `make install`)로 바꿔서 해결. 실제 docker build + container 실행 + `SELECT uuid_generate_v7()`까지 검증 완료
- `db/init/01-create-extension.sql` (신규) — `CREATE EXTENSION IF NOT EXISTS pg_uuidv7;` (fresh volume용 docker-entrypoint-initdb.d 스크립트, vector extension이랑 동일 패턴)
- `docker-compose.yml` — `db` 서비스 `image: pgvector/pgvector:pg16` → `build: context: ./db`
- `prisma/migrations/20260821000000_message_content_id_default/` 삭제 (T10에서 만든 v4 default 마이그레이션, 아직 미배포라 그냥 교체) → `20260821010000_uuidv7_id_defaults/migration.sql` (신규): extension 생성 + `user`/`license_key`/`message`/`message_content`/`memory`/`memory_content`/`schedule` 7개 테이블 `id` DEFAULT를 `uuid_generate_v7()`로 전환
- `schema.prisma` — 7개 테이블의 `@default(uuid())` → `@default(dbgenerated("uuid_generate_v7()"))`

**검증**
- `docker build ./db` 성공, 컨테이너 기동 후 `pg_extension`에 `pg_uuidv7` 등록 확인, `uuid_generate_v7()` 직접 호출해서 정렬 가능한 v7 형태 확인
- 이 DB에 `prisma migrate deploy`로 13개 migration 전체(처음부터) 정상 적용 확인
- `user`/`message_content` 테이블에 실제 INSERT해서 `id` 컬럼에 v7 값이 default로 채워지는 것 확인 (`\d` 결과에 `Default: uuid_generate_v7()`)
- `prisma generate` + `tsc --noEmit` 통과

**미실행**
- 로컬/배포 dev DB엔 아직 이 migration 실제로 안 돌림 (테스트는 별도 임시 컨테이너에서만 검증)

## 보류

- memory 전체 파이프라인 확장 (`analyzeConversation` 등 batch 경로까지 weighted 적용 넓히는 것) — 결정 사항 3번 참고, 테스트 결과 보고 결정
