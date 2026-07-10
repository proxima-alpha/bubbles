'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import api from '@/lib/api';
import { HeaderNav } from '@/components/header-nav';

interface Keyword {
  code: string;
  name: string;
}

interface KnowledgeMemory {
  id: string;
  keywords: Keyword[];
  contents: { id: string; content: string }[];
  version: number;
  isPinned: boolean;
  createdAt: string;
}

export default function MemoryPage() {
  const { data: memories = [], isLoading } = useQuery<KnowledgeMemory[]>({
    queryKey: ['knowledge-memories'],
    queryFn: () => api.get('/memory/knowledge').then(r => r.data),
  });

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <HeaderNav />

      <main className="flex-1 px-4 py-6 max-w-3xl mx-auto w-full">
        <h2 className="text-base font-semibold mb-4">지식 메모리</h2>

        {isLoading && (
          <p className="text-center text-gray-400 text-sm">불러오는 중...</p>
        )}

        {!isLoading && memories.length === 0 && (
          <p className="text-center text-gray-400 text-sm">아직 저장된 지식 메모리가 없습니다.</p>
        )}

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {memories.map(memory => (
            <Link
              key={memory.id}
              href={`/memory/${memory.id}`}
              className="bg-white border rounded-xl p-4 flex flex-col justify-between hover:border-gray-400 transition"
            >
              <ul className="text-sm text-gray-700 space-y-1 mb-3 line-clamp-6 list-disc list-inside">
                {memory.contents.slice(0, 5).map(c => (
                  <li key={c.id}>{c.content}</li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-1.5">
                {memory.keywords.length > 0 ? (
                  memory.keywords.map(kw => (
                    <span
                      key={kw.code}
                      className="text-xs bg-gray-100 text-gray-700 rounded-full px-2.5 py-0.5"
                    >
                      {kw.name}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-gray-400">키워드 없음</span>
                )}
                {memory.isPinned && (
                  <span className="text-xs bg-yellow-100 text-yellow-700 rounded-full px-2.5 py-0.5">
                    고정
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
