-- Spec 3 feed-002: memory <-> memory_content 1:N -> N:M 전환

-- 1. 조인 테이블 생성
CREATE TABLE "memory__memory_content" (
    "memory_id" UUID NOT NULL,
    "memory_content_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "memory__memory_content_pkey" PRIMARY KEY ("memory_id","memory_content_id")
);

ALTER TABLE "memory__memory_content"
    ADD CONSTRAINT "memory__memory_content_memory_id_fkey"
    FOREIGN KEY ("memory_id") REFERENCES "memory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "memory__memory_content"
    ADD CONSTRAINT "memory__memory_content_memory_content_id_fkey"
    FOREIGN KEY ("memory_content_id") REFERENCES "memory_content"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. 기존 memory_content.memory_id/seq 를 조인 테이블로 백필
INSERT INTO "memory__memory_content" ("memory_id", "memory_content_id", "seq")
SELECT "memory_id", "id", "seq" FROM "memory_content";

-- 3. memory_content에 점수/embedding 컬럼 추가 (memory_id/seq는 조인 테이블로 이전되어 제거)
ALTER TABLE "memory_content"
    DROP CONSTRAINT IF EXISTS "memory_content_memory_id_fkey";

ALTER TABLE "memory_content"
    DROP COLUMN "memory_id",
    DROP COLUMN "seq",
    ADD COLUMN "importance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN "durability" DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN "reusefulness" DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN "sensitivity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN "explicit_signal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN "llm_confidence_hint" DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN "repetition_count" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "confirmed_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN "last_referenced_at" TIMESTAMPTZ,
    ADD COLUMN "scored_at" TIMESTAMPTZ;

ALTER TABLE "memory_content" ADD COLUMN "embedding" vector(768);

-- 4. memory 테이블에서 content-단위로 이전된 컬럼 제거 (group centroid용 embedding은 유지)
ALTER TABLE "memory"
    DROP COLUMN "score",
    DROP COLUMN "sensitivity",
    DROP COLUMN "importance",
    DROP COLUMN "durability",
    DROP COLUMN "reusefulness",
    DROP COLUMN "explicit_signal",
    DROP COLUMN "repetition_strength",
    DROP COLUMN "llm_confidence_hint",
    DROP COLUMN "confirmed_score",
    DROP COLUMN "temporary_penalty",
    DROP COLUMN "content";
