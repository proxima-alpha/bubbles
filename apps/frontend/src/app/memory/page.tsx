'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import api from '@/lib/api';

interface Keyword {
  code: string;
  name: string;
}

interface KnowledgeMemory {
  id: string;
  keywords: Keyword[];
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
      <header className="border-b bg-white px-4 py-3 flex items-center justify-between">
        <h1 className="font-bold text-lg">Bubbles</h1>
        <div className="flex gap-4 text-sm">
          <Link href="/chat" className="text-gray-600 hover:text-black">채팅</Link>
          <Link href="/profile" className="text-gray-600 hover:text-black">프로필</Link>
        </div>
      </header>

      <main className="flex-1 px-4 py-6 max-w-2xl mx-auto w-full">
        <h2 className="text-base font-semibold mb-4">지식 메모리</h2>

        {isLoading && (
          <p className="text-center text-gray-400 text-sm">불러오는 중...</p>
        )}

        {!isLoading && memories.length === 0 && (
          <p className="text-center text-gray-400 text-sm">아직 저장된 지식 메모리가 없습니다.</p>
        )}

        <div className="space-y-3">
          {memories.map(memory => (
            <div key={memory.id} className="bg-white border rounded-xl px-4 py-3">
              <div className="flex flex-wrap gap-1.5 mb-2">
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
              <div className="flex items-center justify-between text-xs text-gray-400">
                <span>v{memory.version}</span>
                <span>{new Date(memory.createdAt).toLocaleDateString('ko-KR')}</span>
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
