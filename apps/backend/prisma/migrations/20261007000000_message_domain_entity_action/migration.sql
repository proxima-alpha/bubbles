ALTER TABLE "message" DROP COLUMN "topic_labels";
ALTER TABLE "message" ADD COLUMN "domain" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "message" ADD COLUMN "entity" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "message" ADD COLUMN "action" TEXT[] NOT NULL DEFAULT '{}';
