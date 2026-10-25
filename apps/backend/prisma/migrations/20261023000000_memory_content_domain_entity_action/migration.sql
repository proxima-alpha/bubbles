ALTER TABLE "memory_content" ADD COLUMN "domain" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "memory_content" ADD COLUMN "entity" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "memory_content" ADD COLUMN "action" TEXT[] NOT NULL DEFAULT '{}';
