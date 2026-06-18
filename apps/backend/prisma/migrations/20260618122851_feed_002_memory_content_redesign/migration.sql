/*
  Warnings:

  - You are about to drop the column `order` on the `memory_content` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "memory_content" DROP COLUMN "order";

-- AlterTable
ALTER TABLE "message" ADD COLUMN     "parent_message_id" UUID;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_parent_message_id_fkey" FOREIGN KEY ("parent_message_id") REFERENCES "message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
