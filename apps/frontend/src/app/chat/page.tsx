'use client';

import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

interface UserProfile {
  email: string;
  model: string | null;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export default function ChatPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [input, setInput] = useState('');
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: userProfile, isLoading: profileLoading } = useQuery<UserProfile>({
    queryKey: ['user'],
    queryFn: () => api.get('/user').then(r => r.data),
  });

  const { data: messages = [], isLoading: historyLoading } = useQuery<Message[]>({
    queryKey: ['chat-history'],
    queryFn: () => api.get('/chat/history').then(r => r.data),
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

    const res = await fetch(`${API_URL}/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ content }),
    });

    if (!res.ok || !res.body) {
      setIsStreaming(false);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = decoder.decode(value).split('\n').filter(l => l.startsWith('data: '));
      for (const line of lines) {
        const payload = line.slice(6);
        if (payload === '[DONE]') {
          setIsStreaming(false);
          setStreamingContent('');
          queryClient.invalidateQueries({ queryKey: ['chat-history'] });
          return;
        }
        const { token } = JSON.parse(payload);
        setStreamingContent(prev => prev + token);
      }
    }

    setIsStreaming(false);
  };

  const handleLogout = async () => {
    await api.post('/auth/logout');
    router.replace('/login');
  };

  if (profileLoading) {
    return <div className="min-h-screen flex items-center justify-center text-gray-400">로딩 중...</div>;
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <header className="border-b bg-white px-4 py-3 flex items-center justify-between">
        <h1 className="font-bold text-lg">Bubbles</h1>
        <div className="flex gap-4 text-sm">
          <Link href="/profile" className="text-gray-600 hover:text-black">프로필</Link>
          <button onClick={handleLogout} className="text-gray-600 hover:text-black">로그아웃</button>
        </div>
      </header>

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
                  {msg.role === 'assistant' && (
                    <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-xs font-bold mr-2 flex-shrink-0 self-end">
                      AI
                    </div>
                  )}
                  <div className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-black text-white rounded-br-sm'
                      : 'bg-white border text-gray-800 rounded-bl-sm'
                  }`}>
                    {msg.content}
                  </div>
                </div>
              ))}
              {isStreaming && (
                <div className="flex justify-start">
                  <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-xs font-bold mr-2 flex-shrink-0 self-end">
                    AI
                  </div>
                  <div className="bg-white border rounded-2xl rounded-bl-sm px-4 py-2 text-sm whitespace-pre-wrap text-gray-800 max-w-[75%]">
                    {streamingContent || <span className="text-gray-400">...</span>}
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
