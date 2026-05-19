import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  const categories = [
    { code: 'role', name: '메시지 역할', order: 1 },
    { code: 'provider', name: 'LLM provider', order: 2 },
    { code: 'model', name: 'LLM 모델 버전', order: 3 },
    { code: 'memory_type', name: '메모리 유형', order: 4 },
    { code: 'memory_history_type', name: '메모리 히스토리 유형', order: 5 },
    { code: 'schedule_type', name: '스케줄 유형', order: 6 },
  ];

  for (const cat of categories) {
    await prisma.common_code_category.upsert({
      where: { code: cat.code },
      update: {},
      create: cat,
    });
  }

  const codes = [
    { category_code: 'role', code: 'user', name: '사용자', order: 1 },
    { category_code: 'role', code: 'assistant', name: 'AI', order: 2 },
    { category_code: 'provider', code: 'ollama', name: 'Ollama', order: 1 },
    {
      category_code: 'model',
      code: 'exaone3.5:2.4b',
      name: 'EXAONE 3.5 2.4B',
      parent_category_code: 'provider',
      parent_code: 'ollama',
      order: 1,
    },
    { category_code: 'memory_type', code: 'main', name: '메인 메모리', order: 1 },
    { category_code: 'memory_type', code: 'knowledge', name: '지식 메모리', order: 2 },
    { category_code: 'memory_history_type', code: 'created', name: '시스템 자동 생성', order: 1 },
    { category_code: 'memory_history_type', code: 'renewed', name: '시스템 자동 수정', order: 2 },
    { category_code: 'memory_history_type', code: 'uploaded', name: '이용자 수동 업로드', order: 3 },
    { category_code: 'memory_history_type', code: 'modified', name: '이용자 수동 수정', order: 4 },
    { category_code: 'schedule_type', code: 'memory_batch', name: '메모리 배치', order: 1 },
  ];

  for (const code of codes) {
    await prisma.common_code.upsert({
      where: { category_code_code: { category_code: code.category_code, code: code.code } },
      update: {},
      create: code,
    });
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
