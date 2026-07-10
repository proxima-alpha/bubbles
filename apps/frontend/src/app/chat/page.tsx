'use client';

import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import { HeaderNav } from '@/components/header-nav';

interface CodeDto {
  code: string;
  name: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  provider: CodeDto | null;
  model: CodeDto | null;
  content: string;
  createdAt: string;
}

interface UserProfile {
  email: string;
  model: CodeDto | null;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export default function ChatPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [input, setInput] = useState('');
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingMeta, setStreamingMeta] = useState<{ provider: CodeDto | null; model: CodeDto | null }>({ provider: null, model: null });
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: userProfile, isLoading: profileLoading } = useQuery<UserProfile>({
    queryKey: ['user'],
    queryFn: () => api.get('/auth/me').then(r => r.data),
    throwOnError: (err: any) => err.response?.status >= 500,
  });

  const { data: messages = [], isLoading: historyLoading } = useQuery<Message[]>({
    queryKey: ['chat-history'],
    queryFn: () => api.get('/chat/history').then(r => [...r.data].reverse()),
    enabled: !!userProfile?.model,
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;

    const content = input.trim();
    setInput('');
    setIsStreaming(true);
    setStreamingContent('');
    setStreamingMeta({ provider: null, model: null });

    queryClient.setQueryData<Message[]>(['chat-history'], old => [
      ...(old ?? []),
      { id: 'optimistic', role: 'user', content, createdAt: new Date().toISOString() },
    ]);

    try {
      const res = await fetch(`${API_URL}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content }),
      });

      if (res.status === 401) {
        router.replace('/login');
        return;
      }

      if (!res.ok || !res.body) return;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const event of events) {
          const payload = event
            .split('\n')
            .filter(line => line.startsWith('data: '))
            .map(line => line.slice(6))
            .join('\n');

          if (!payload) continue;
          if (payload === '[DONE]') return;

          const parsed = JSON.parse(payload);
          if (parsed.type === 'meta') {
            setStreamingMeta({ provider: parsed.provider, model: parsed.model });
            continue;
          }
          setStreamingContent(prev => prev + (parsed.token ?? ''));
        }

        if (done) break;
      }

      const payload = buffer
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => line.slice(6))
        .join('\n');

      if (payload !== '[DONE]' && payload) {
        const parsed = JSON.parse(payload);
        if (parsed.token) setStreamingContent(prev => prev + parsed.token);
      }
    } finally {
      setIsStreaming(false);
      setStreamingContent('');
      queryClient.invalidateQueries({ queryKey: ['chat-history'] });
    }
  };

  if (profileLoading) {
    return <div className="min-h-screen flex items-center justify-center text-gray-400">로딩 중...</div>;
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <HeaderNav />

      {!userProfile?.model ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-4">
            <p className="text-gray-600">사용할 모델을 먼저 선택해주세요.</p>
            <Link href="/profile" className="inline-block bg-black text-white px-4 py-2 rounded text-sm">
              프로필에서 설정
            </Link>
          </div>
        </div>
      ) : (
        <>
          <main className="flex-1 overflow-y-auto px-4 py-6 max-w-2xl mx-auto w-full">
            {historyLoading && (
              <p className="text-center text-gray-400 text-sm">불러오는 중...</p>
            )}
            <div className="space-y-4">
              {messages.map(msg => (
                <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'assistant' ? (
                    <div className="flex flex-col items-start max-w-[75%]">
                      <div className="bg-white border text-gray-800 rounded-2xl rounded-bl-sm px-4 py-2 text-sm whitespace-pre-wrap">
                        {msg.content}
                      </div>
                      <div className="flex items-center gap-1.5 mt-1.5">
                        <div className="w-10 h-10 rounded-full overflow-hidden bg-gray-200 flex items-center justify-center text-xs font-bold flex-shrink-0">
                          {msg.provider ? (
                            <img
                              src={`/image/provider/thumb/${msg.provider.code}.png`}
                              alt={msg.provider.name}
                              className="w-full h-full object-cover"
                              onError={e => { e.currentTarget.style.display = 'none'; e.currentTarget.parentElement!.textContent = '?'; }}
                            />
                          ) : '?'}
                        </div>
                        <div className="flex flex-col">
                          {msg.provider && (
                            <span className="text-xs text-gray-400">{msg.provider.name}</span>
                          )}
                          <span className="text-[10px] text-gray-300">
                            {new Date(msg.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="max-w-[75%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap bg-black text-white rounded-br-sm">
                      {msg.content}
                    </div>
                  )}
                </div>
              ))}
              {isStreaming && (
                <div className="flex justify-start">
                  <div className="flex flex-col items-start max-w-[75%]">
                    <div className="bg-white border rounded-2xl rounded-bl-sm px-4 py-2 text-sm whitespace-pre-wrap text-gray-800">
                      {streamingContent || <span className="text-gray-400">...</span>}
                    </div>
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <div className="w-10 h-10 rounded-full overflow-hidden bg-gray-200 flex items-center justify-center text-xs font-bold flex-shrink-0">
                        {streamingMeta.provider ? (
                          <img
                            src={`/image/provider/thumb/${streamingMeta.provider.code}.png`}
                            alt={streamingMeta.provider.name}
                            className="w-full h-full object-cover"
                            onError={e => { e.currentTarget.style.display = 'none'; e.currentTarget.parentElement!.textContent = '?'; }}
                          />
                        ) : '?'}
                      </div>
                      {streamingMeta.provider && (
                        <span className="text-xs text-gray-400">{streamingMeta.provider.name}</span>
                      )}
                    </div>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          </main>

          <footer className="border-t bg-white px-4 py-3">
            <form onSubmit={handleSubmit} className="flex gap-2 max-w-2xl mx-auto">
              <input
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder="메시지를 입력하세요..."
                className="flex-1 border rounded-full px-4 py-2 text-sm outline-none focus:ring-1 focus:ring-black"
              />
              <button
                type="submit"
                disabled={!input.trim() || isStreaming}
                className="bg-black text-white rounded-full px-4 py-2 text-sm disabled:opacity-50"
              >
                전송
              </button>
            </form>
          </footer>
        </>
      )}
    </div>
  );
}
