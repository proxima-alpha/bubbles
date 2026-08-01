'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import useEmblaCarousel from 'embla-carousel-react';
import api from '@/lib/api';

interface Keyword {
  code: string;
  name: string;
}

interface MemoryContent {
  id: string;
  content: string;
}

interface MemoryVersion {
  id: string;
  keywords: Keyword[];
  contents: MemoryContent[];
  version: number;
  isPinned: boolean;
  createdAt: string;
  summary: string | null;
}

interface EvidenceMessage {
  id: string;
  role: string;
  content: string;
}

export default function MemoryDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);

  const { data: history = [], isLoading } = useQuery<MemoryVersion[]>({
    queryKey: ['memory-history', params.id],
    queryFn: () => api.get(`/memory/knowledge/${params.id}/history`).then(r => r.data),
  });
  const [emblaRef] = useEmblaCarousel({ align: 'center' });

  const pinMutation = useMutation({
    mutationFn: (id: string) => api.patch(`/memory/knowledge/${id}/pin`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['memory-history', params.id] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/memory/knowledge/${id}`),
    onSuccess: () => router.push('/memory'),
  });

  const editMutation = useMutation({
    mutationFn: ({ id, contents, summary }: { id: string; contents: string[]; summary: string }) =>
      api.put(`/memory/knowledge/${id}`, { contents, summary }),
    onSuccess: () => {
      setEditingId(null);
      queryClient.invalidateQueries({ queryKey: ['memory-history', params.id] });
    },
  });

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <header className="border-b bg-white px-4 py-3 flex items-center gap-4">
        <Link href="/memory" className="text-gray-600 hover:text-black text-sm">
          ← 메모리
        </Link>
        <h1 className="font-bold text-lg">메모리 상세</h1>
      </header>

      {isLoading && (
        <p className="text-center text-gray-400 text-sm py-6">불러오는 중...</p>
      )}

      {!isLoading && history.length === 0 && (
        <p className="text-center text-gray-400 text-sm py-6">메모리를 찾을 수 없습니다.</p>
      )}

      <div className="overflow-hidden py-6" ref={emblaRef}>
        <div className="flex gap-4 px-4">
          {history.map((version, idx) => {
            const isLatest = idx === 0;
            const isEditing = editingId === version.id;
            return (
              <div key={version.id} className="shrink-0 w-[85vw] max-w-md bg-white border rounded-xl p-4">
                <div className="flex items-center justify-between text-xs text-gray-400 mb-3">
                  <span>v{version.version}{version.isPinned && ' · 고정'}</span>
                  <span>{new Date(version.createdAt).toLocaleDateString('ko-KR')}</span>
                </div>

                {isEditing ? (
                  <EditForm
                    version={version}
                    onCancel={() => setEditingId(null)}
                    onSave={(contents, summary) => editMutation.mutate({ id: version.id, contents, summary })}
                    isSaving={editMutation.isPending}
                  />
                ) : (
                  <>
                    <div className="space-y-2 mb-3">
                      {version.contents.map(c => (
                        <ContentLine key={c.id} content={c} />
                      ))}
                    </div>

                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {version.keywords.map(kw => (
                        <span key={kw.code} className="text-xs bg-gray-100 text-gray-700 rounded-full px-2.5 py-0.5">
                          {kw.name}
                        </span>
                      ))}
                    </div>

                    <div className="flex gap-2 pt-2 border-t">
                      {isLatest && (
                        <>
                          <button
                            onClick={() => setEditingId(version.id)}
                            className="text-xs text-gray-600 hover:text-black"
                          >
                            편집
                          </button>
                          <button
                            onClick={() => pinMutation.mutate(version.id)}
                            disabled={pinMutation.isPending}
                            className="text-xs text-gray-600 hover:text-black disabled:opacity-50"
                          >
                            {version.isPinned ? '고정 해제' : '고정'}
                          </button>
                          <button
                            onClick={() => {
                              if (confirm('이 메모리를 삭제하시겠습니까?')) deleteMutation.mutate(version.id);
                            }}
                            disabled={deleteMutation.isPending}
                            className="text-xs text-red-600 hover:text-red-800 disabled:opacity-50"
                          >
                            삭제
                          </button>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function EditForm({
  version,
  onCancel,
  onSave,
  isSaving,
}: {
  version: MemoryVersion;
  onCancel: () => void;
  onSave: (contents: string[], summary: string) => void;
  isSaving: boolean;
}) {
  const [contentsText, setContentsText] = useState(version.contents.map(c => c.content).join('\n'));
  const [summary, setSummary] = useState(version.summary ?? '');

  return (
    <div className="space-y-2 mb-3">
      <textarea
        value={contentsText}
        onChange={e => setContentsText(e.target.value)}
        rows={6}
        placeholder="한 줄에 문장 하나씩"
        className="w-full border rounded px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-black"
      />
      <textarea
        value={summary}
        onChange={e => setSummary(e.target.value)}
        rows={2}
        placeholder="요약"
        className="w-full border rounded px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-black"
      />
      <div className="flex gap-2">
        <button
          onClick={() => {
            const contents = contentsText.split('\n').map(s => s.trim()).filter(Boolean);
            onSave(contents, summary);
          }}
          disabled={isSaving}
          className="bg-black text-white rounded px-3 py-1.5 text-xs disabled:opacity-50"
        >
          저장
        </button>
        <button onClick={onCancel} className="text-xs text-gray-600 hover:text-black">
          취소
        </button>
      </div>
    </div>
  );
}

function ContentLine({ content }: { content: MemoryContent }) {
  const [open, setOpen] = useState(false);
  const { data: messages, isFetching } = useQuery<EvidenceMessage[]>({
    queryKey: ['content-messages', content.id],
    queryFn: () => api.get(`/memory/content/${content.id}/messages`).then(r => r.data),
    enabled: open,
  });

  return (
    <div>
      <button onClick={() => setOpen(v => !v)} className="text-sm text-left hover:underline">
        {content.content}
      </button>
      {open && (
        <div className="mt-1 ml-3 border-l-2 pl-3 space-y-1 text-xs text-gray-500">
          {isFetching && <p>불러오는 중...</p>}
          {messages?.map(m => (
            <p key={m.id}>[{m.role}] {m.content}</p>
          ))}
        </div>
      )}
    </div>
  );
}
