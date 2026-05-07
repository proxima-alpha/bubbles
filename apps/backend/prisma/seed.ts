import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const categories = [
    { code: 'role', name: '메시지 역할', order: 1 },
    { code: 'provider', name: 'LLM provider', order: 2 },
    { code: 'model', name: 'LLM 모델 버전', order: 3 },
    { code: 'memory_type', name: '메모리 유형', order: 4 },
    { code: 'memory_history_type', name: '메모리 히스토리 유형', order: 5 },
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
    { category_code: 'provider', code: 'claude', name: 'Claude', order: 1 },
    { category_code: 'provider', code: 'gpt', name: 'GPT', order: 2 },
    {
      category_code: 'model',
      code: 'claude-opus-4-7',
      name: 'Claude Opus 4.7',
      parent_category_code: 'provider',
      parent_code: 'claude',
      order: 1,
    },
    {
      category_code: 'model',
      code: 'gpt-4o-2024-08-06',
      name: 'GPT-4o',
      parent_category_code: 'provider',
      parent_code: 'gpt',
      order: 2,
    },
    { category_code: 'memory_type', code: 'main', name: '메인 메모리', order: 1 },
    { category_code: 'memory_type', code: 'knowledge', name: '지식 메모리', order: 2 },
    { category_code: 'memory_history_type', code: 'created', name: '시스템 자동 생성', order: 1 },
    { category_code: 'memory_history_type', code: 'renewed', name: '시스템 자동 수정', order: 2 },
    { category_code: 'memory_history_type', code: 'uploaded', name: '이용자 수동 업로드', order: 3 },
    { category_code: 'memory_history_type', code: 'modified', name: '이용자 수동 수정', order: 4 },
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
