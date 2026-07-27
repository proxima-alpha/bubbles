-- AlterTable
ALTER TABLE "public"."message" DROP COLUMN "summary";

-- CreateTable
CREATE TABLE "public"."message_content" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(768),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_content_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_content_message_id_seq_idx" ON "public"."message_content"("message_id" ASC, "seq" ASC);

-- AddForeignKey
ALTER TABLE "public"."message_content" ADD CONSTRAINT "message_content_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
