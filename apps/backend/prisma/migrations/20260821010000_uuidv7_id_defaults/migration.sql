-- Enable pg_uuidv7 extension
CREATE EXTENSION IF NOT EXISTS pg_uuidv7;

-- Switch all UUID primary key defaults from gen_random_uuid() (v4) to uuid_generate_v7()
ALTER TABLE "user" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
ALTER TABLE "license_key" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
ALTER TABLE "message" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
ALTER TABLE "message_content" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
ALTER TABLE "memory" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
ALTER TABLE "memory_content" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
ALTER TABLE "schedule" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
