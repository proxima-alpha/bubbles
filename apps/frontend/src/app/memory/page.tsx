'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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

interface MainMemory {
  summary: string | null;
  updatedAt: string | null;
}

function MainMemoryCard() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [summary, setSummary] = useState('');

  const { data: main, isLoading } = useQuery<MainMemory>({
    queryKey: ['main-memory'],
    queryFn: () => api.get('/memory/main').then(r => r.data),
  });

  useEffect(() => {
    if (main) setSummary(main.summary ?? '');
  }, [main]);

  const updateMutation = useMutation({
    mutationFn: (summary: string) => api.put('/memory/main', { summary }),
    onSuccess: () => {
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ['main-memory'] });
    },
  });

  if (isLoading) return null;

  return (
    <div className="bg-white border rounded-xl p-4 mb-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold">메인 메모리</h2>
        {!editing && (
          <button onClick={() => setEditing(true)} className="text-xs text-gray-600 hover:text-black">
            편집
          </button>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <textarea
            value={summary}
            onChange={e => setSummary(e.target.value)}
            rows={5}
            className="w-full border rounded px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-black"
          />
          <div className="flex gap-2">
            <button
              onClick={() => updateMutation.mutate(summary)}
              disabled={updateMutation.isPending}
              className="bg-black text-white rounded px-3 py-1.5 text-xs disabled:opacity-50"
            >
              저장
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setSummary(main?.summary ?? '');
              }}
              className="text-xs text-gray-600 hover:text-black"
            >
              취소
            </button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-gray-700 whitespace-pre-wrap">
          {main?.summary || <span className="text-gray-400">아직 생성된 메인 메모리가 없습니다.</span>}
        </p>
      )}
    </div>
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function MemoryPage() {
  const queryClient = useQueryClient();
  const { data: memories = [], isLoading } = useQuery<KnowledgeMemory[]>({
    queryKey: ['knowledge-memories'],
    queryFn: () => api.get('/memory/knowledge').then(r => r.data),
  });

  const importMutation = useMutation({
    mutationFn: (content: string) => api.post('/memory/import', { content }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['knowledge-memories'] }),
  });

  const handleExportAll = async () => {
    const res = await api.get('/memory/export', { responseType: 'blob' });
    downloadBlob(res.data, 'memory-export.md');
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    importMutation.mutate(content);
    e.target.value = '';
  };

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <HeaderNav />

      <main className="flex-1 px-4 py-6 max-w-2xl mx-auto w-full">
        <MainMemoryCard />

        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">지식 메모리</h2>
          <div className="flex items-center gap-3">
            <label className="text-xs text-gray-600 hover:text-black cursor-pointer">
              가져오기
              <input type="file" accept=".md" onChange={handleImportFile} className="hidden" />
            </label>
            <button onClick={handleExportAll} className="text-xs text-gray-600 hover:text-black">
              전체 내보내기
            </button>
          </div>
        </div>

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
