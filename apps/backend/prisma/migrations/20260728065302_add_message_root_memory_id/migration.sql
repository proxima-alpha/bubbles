-- AlterTable
ALTER TABLE "message" ADD COLUMN     "root_memory_id" UUID;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_root_memory_id_fkey" FOREIGN KEY ("root_memory_id") REFERENCES "memory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
