'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
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
}

interface EvidenceMessage {
  id: string;
  role: string;
  content: string;
}

export default function MemoryDetailPage({ params }: { params: { id: string } }) {
  const { data: history = [], isLoading } = useQuery<MemoryVersion[]>({
    queryKey: ['memory-history', params.id],
    queryFn: () => api.get(`/memory/knowledge/${params.id}/history`).then(r => r.data),
  });
  const [emblaRef] = useEmblaCarousel({ align: 'center' });

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
          {history.map(version => (
            <div key={version.id} className="shrink-0 w-[85vw] max-w-md bg-white border rounded-xl p-4">
              <div className="flex items-center justify-between text-xs text-gray-400 mb-3">
                <span>v{version.version}{version.isPinned && ' · 고정'}</span>
                <span>{new Date(version.createdAt).toLocaleDateString('ko-KR')}</span>
              </div>

              <div className="space-y-2 mb-3">
                {version.contents.map(c => (
                  <ContentLine key={c.id} content={c} />
                ))}
              </div>

              <div className="flex flex-wrap gap-1.5">
                {version.keywords.map(kw => (
                  <span key={kw.code} className="text-xs bg-gray-100 text-gray-700 rounded-full px-2.5 py-0.5">
                    {kw.name}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
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
