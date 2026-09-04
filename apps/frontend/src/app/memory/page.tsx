'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import api from '@/lib/api';
import { HeaderNav } from '@/components/header-nav';
import { Trash2 } from 'lucide-react';

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
  contents: { id: string; content: string }[];
  updatedAt: string | null;
}

function MainMemoryCard() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const { data: main, isLoading } = useQuery<MainMemory>({
    queryKey: ['main-memory'],
    queryFn: () => api.get('/memory/main').then(r => r.data),
  });

  useEffect(() => {
    if (main) setLines(main.contents.map(c => c.content));
  }, [main]);

  const updateMutation = useMutation({
    mutationFn: (contents: string[]) => api.put('/memory/main', { contents }),
    onSuccess: () => {
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ['main-memory'] });
    },
  });

  const moveLine = (from: number, to: number) => {
    if (from === to) return;
    setLines(prev => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

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
          {lines.map((line, i) => (
            <div
              key={i}
              draggable
              onDragStart={() => setDragIndex(i)}
              onDragOver={e => e.preventDefault()}
              onDrop={() => {
                if (dragIndex !== null) moveLine(dragIndex, i);
                setDragIndex(null);
              }}
              className="flex items-center gap-2"
            >
              <span className="cursor-grab text-gray-400 select-none">⠿</span>
              <input
                value={line}
                onChange={e => setLines(prev => prev.map((l, idx) => (idx === i ? e.target.value : l)))}
                className="flex-1 border rounded px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-black"
              />
              <button
                onClick={() => setLines(prev => prev.filter((_, idx) => idx !== i))}
                className="text-gray-400 hover:text-red-600"
                aria-label="삭제"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <button
            onClick={() => setLines(prev => [...prev, ''])}
            className="w-full border border-dashed rounded px-2 py-1.5 text-sm text-gray-500 hover:text-black hover:border-gray-400"
          >
            + 추가
          </button>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setEditing(false);
                setLines(main?.contents.map(c => c.content) ?? []);
              }}
              className="text-xs text-gray-600 hover:text-black"
            >
              취소
            </button>
            <button
              onClick={() => updateMutation.mutate(lines.filter(Boolean))}
              disabled={updateMutation.isPending}
              className="bg-black text-white rounded px-3 py-1.5 text-xs disabled:opacity-50"
            >
              저장
            </button>
          </div>
        </div>
      ) : main && main.contents.length > 0 ? (
        <ul className="text-sm text-gray-700 space-y-1 list-disc list-inside">
          {main.contents.map(c => (
            <li key={c.id}>{c.content}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-400">아직 생성된 메인 메모리가 없습니다.</p>
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

  const handleExportAll = async () => {
    const res = await api.get('/memory/export', { responseType: 'blob' });
    downloadBlob(res.data, 'memory-export.md');
  };

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <HeaderNav />

      <main className="flex-1 px-4 py-6 max-w-2xl mx-auto w-full">
        <MainMemoryCard />

        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">지식 메모리</h2>
          <div className="flex items-center gap-3">
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
