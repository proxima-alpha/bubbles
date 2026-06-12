-- AlterTable
ALTER TABLE "license_key" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "memory" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "memory_content" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "message" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "schedule" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "user" ALTER COLUMN "id" DROP DEFAULT;

-- RenameForeignKey
ALTER TABLE "common_code" RENAME CONSTRAINT "common_code_parent_fkey" TO "common_code_parent_category_code_parent_code_fkey";

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_model_category_model_fkey" FOREIGN KEY ("model_category", "model") REFERENCES "common_code"("category_code", "code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "license_key" ADD CONSTRAINT "license_key_provider_category_provider_fkey" FOREIGN KEY ("provider_category", "provider") REFERENCES "common_code"("category_code", "code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_role_category_role_fkey" FOREIGN KEY ("role_category", "role") REFERENCES "common_code"("category_code", "code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_provider_category_provider_fkey" FOREIGN KEY ("provider_category", "provider") REFERENCES "common_code"("category_code", "code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_model_category_model_fkey" FOREIGN KEY ("model_category", "model") REFERENCES "common_code"("category_code", "code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory" ADD CONSTRAINT "memory_type_category_type_fkey" FOREIGN KEY ("type_category", "type") REFERENCES "common_code"("category_code", "code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory" ADD CONSTRAINT "memory_history_type_category_history_type_fkey" FOREIGN KEY ("history_type_category", "history_type") REFERENCES "common_code"("category_code", "code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_type_category_type_fkey" FOREIGN KEY ("type_category", "type") REFERENCES "common_code"("category_code", "code") ON DELETE RESTRICT ON UPDATE CASCADE;
