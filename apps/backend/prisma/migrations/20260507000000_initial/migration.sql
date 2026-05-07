-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- updated_at auto-update trigger function
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- CreateTable: common_code_category
CREATE TABLE "common_code_category" (
    "code" VARCHAR NOT NULL,
    "name" VARCHAR NOT NULL,
    "description" TEXT,
    "order" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "common_code_category_pkey" PRIMARY KEY ("code")
);

CREATE TRIGGER set_updated_at_common_code_category
BEFORE UPDATE ON "common_code_category"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- CreateTable: common_code
CREATE TABLE "common_code" (
    "category_code" VARCHAR NOT NULL,
    "code" VARCHAR NOT NULL,
    "parent_category_code" VARCHAR,
    "parent_code" VARCHAR,
    "name" VARCHAR NOT NULL,
    "description" TEXT,
    "value" TEXT,
    "order" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "common_code_pkey" PRIMARY KEY ("category_code", "code")
);

CREATE TRIGGER set_updated_at_common_code
BEFORE UPDATE ON "common_code"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- CreateTable: user
CREATE TABLE "user" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "model_category" VARCHAR NOT NULL DEFAULT 'model',
    "model" VARCHAR,
    "email" VARCHAR NOT NULL,
    "password" VARCHAR NOT NULL,
    "salt" VARCHAR NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

CREATE TRIGGER set_updated_at_user
BEFORE UPDATE ON "user"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- CreateTable: license_key
CREATE TABLE "license_key" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "provider_category" VARCHAR NOT NULL DEFAULT 'provider',
    "provider" VARCHAR NOT NULL,
    "key" VARCHAR NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "license_key_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "license_key_user_id_provider_key" ON "license_key"("user_id", "provider");

CREATE TRIGGER set_updated_at_license_key
BEFORE UPDATE ON "license_key"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- CreateTable: message
CREATE TABLE "message" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "role_category" VARCHAR NOT NULL DEFAULT 'role',
    "role" VARCHAR NOT NULL,
    "provider_category" VARCHAR NOT NULL DEFAULT 'provider',
    "provider" VARCHAR,
    "model_category" VARCHAR NOT NULL DEFAULT 'model',
    "model" VARCHAR,
    "content" TEXT NOT NULL,
    "embedding" vector(768),
    "is_proceeded" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateTable: memory
CREATE TABLE "memory" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "root_memory_id" UUID,
    "parent_memory_id" UUID,
    "type_category" VARCHAR NOT NULL DEFAULT 'memory_type',
    "type" VARCHAR NOT NULL,
    "history_type_category" VARCHAR NOT NULL DEFAULT 'memory_history_type',
    "history_type" VARCHAR,
    "keywords" TEXT[] NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deactivated_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "memory_pkey" PRIMARY KEY ("id")
);

CREATE TRIGGER set_updated_at_memory
BEFORE UPDATE ON "memory"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- CreateTable: memory_content
CREATE TABLE "memory_content" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "memory_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "memory_content_pkey" PRIMARY KEY ("id")
);

-- CreateTable: memory_content__message
CREATE TABLE "memory_content__message" (
    "memory_content_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "memory_content__message_pkey" PRIMARY KEY ("memory_content_id", "message_id")
);

-- AddForeignKey: common_code → common_code_category
ALTER TABLE "common_code"
    ADD CONSTRAINT "common_code_category_code_fkey"
    FOREIGN KEY ("category_code") REFERENCES "common_code_category"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: common_code self-referencing parent
ALTER TABLE "common_code"
    ADD CONSTRAINT "common_code_parent_fkey"
    FOREIGN KEY ("parent_category_code", "parent_code") REFERENCES "common_code"("category_code", "code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: license_key → user
ALTER TABLE "license_key"
    ADD CONSTRAINT "license_key_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: message → user
ALTER TABLE "message"
    ADD CONSTRAINT "message_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: memory → user
ALTER TABLE "memory"
    ADD CONSTRAINT "memory_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: memory self-referencing root
ALTER TABLE "memory"
    ADD CONSTRAINT "memory_root_memory_id_fkey"
    FOREIGN KEY ("root_memory_id") REFERENCES "memory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: memory self-referencing parent
ALTER TABLE "memory"
    ADD CONSTRAINT "memory_parent_memory_id_fkey"
    FOREIGN KEY ("parent_memory_id") REFERENCES "memory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: memory_content → memory
ALTER TABLE "memory_content"
    ADD CONSTRAINT "memory_content_memory_id_fkey"
    FOREIGN KEY ("memory_id") REFERENCES "memory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: memory_content__message → memory_content
ALTER TABLE "memory_content__message"
    ADD CONSTRAINT "memory_content__message_memory_content_id_fkey"
    FOREIGN KEY ("memory_content_id") REFERENCES "memory_content"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: memory_content__message → message
ALTER TABLE "memory_content__message"
    ADD CONSTRAINT "memory_content__message_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
