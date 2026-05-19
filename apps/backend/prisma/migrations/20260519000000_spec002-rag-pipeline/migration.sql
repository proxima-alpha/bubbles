-- message: add token columns
ALTER TABLE "message"
  ADD COLUMN "input_tokens" INTEGER,
  ADD COLUMN "output_tokens" INTEGER;

-- memory: drop keywords array, add score components + embedding + content fields
ALTER TABLE "memory"
  DROP COLUMN "keywords",
  ADD COLUMN "score"               DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "scored_at"           TIMESTAMPTZ,
  ADD COLUMN "sensitivity"         DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "importance"          DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "durability"          DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "reusefulness"        DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "explicit_signal"     DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "repetition_strength" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "user_action_score"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "llm_confidence_hint" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "confirmed_score"     DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "temporary_penalty"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "content"             TEXT,
  ADD COLUMN "summary"             TEXT,
  ADD COLUMN "last_referenced_at"  TIMESTAMPTZ,
  ADD COLUMN "reference_count"     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "embedding"           vector(768);

-- keyword table
CREATE TABLE "keyword" (
    "code"        VARCHAR NOT NULL,
    "name"        VARCHAR NOT NULL,
    "description" TEXT,
    "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "keyword_pkey" PRIMARY KEY ("code")
);

-- memory__keyword junction table
CREATE TABLE "memory__keyword" (
    "memory_id"    UUID    NOT NULL,
    "keyword_code" VARCHAR NOT NULL,

    CONSTRAINT "memory__keyword_pkey" PRIMARY KEY ("memory_id", "keyword_code")
);

ALTER TABLE "memory__keyword"
  ADD CONSTRAINT "memory__keyword_memory_id_fkey"
    FOREIGN KEY ("memory_id") REFERENCES "memory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "memory__keyword"
  ADD CONSTRAINT "memory__keyword_keyword_code_fkey"
    FOREIGN KEY ("keyword_code") REFERENCES "keyword"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- schedule table
CREATE TABLE "schedule" (
    "id"            UUID    NOT NULL DEFAULT gen_random_uuid(),
    "user_id"       UUID    NOT NULL,
    "type_category" VARCHAR NOT NULL DEFAULT 'schedule_type',
    "type"          VARCHAR NOT NULL,
    "created_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "schedule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "schedule_user_id_type_key" ON "schedule"("user_id", "type");

ALTER TABLE "schedule"
  ADD CONSTRAINT "schedule_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER set_updated_at_schedule
BEFORE UPDATE ON "schedule"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
