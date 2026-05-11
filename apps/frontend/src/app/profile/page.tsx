'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import api from '@/lib/api';

const MODELS = [
  { code: 'qwen2.5:3b', name: 'Qwen 2.5 3B' },
];

interface UserProfile {
  email: string;
  model: string | null;
}

export default function ProfilePage() {
  const queryClient = useQueryClient();

const { data: profile, isLoading } = useQuery<UserProfile>({
    queryKey: ['user'],
    queryFn: () => api.get('/user').then(r => r.data),
  });

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [userMsg, setUserMsg] = useState('');
  const [modelMsg, setModelMsg] = useState('');

  useEffect(() => {
    if (profile) setEmail(profile.email);
  }, [profile]);

  const updateUserMutation = useMutation({
    mutationFn: (data: { email?: string; password?: string }) => api.put('/user', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user'] });
      setPassword('');
      setUserMsg('저장되었습니다.');
      setTimeout(() => setUserMsg(''), 3000);
    },
  });

  const updateModelMutation = useMutation({
    mutationFn: (model: string) => api.put('/user/model', { model }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user'] });
      setModelMsg('저장되었습니다.');
      setTimeout(() => setModelMsg(''), 3000);
    },
  });

  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center text-gray-400">로딩 중...</div>;
  }

  if (!profile) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b bg-white px-4 py-3 flex items-center gap-4">
        <Link href="/chat" className="text-gray-600 hover:text-black text-sm">
          ← 채팅
        </Link>
        <h1 className="font-bold text-lg">프로필</h1>
      </header>

      <div className="max-w-lg mx-auto p-6 space-y-6">
        <section className="bg-white rounded-lg p-6 shadow-sm">
          <h2 className="font-semibold mb-4">계정 정보</h2>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium mb-1">이메일</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full border rounded px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-black"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">새 비밀번호</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="변경하려면 입력하세요"
                className="w-full border rounded px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-black"
              />
            </div>
            {userMsg && <p className="text-green-600 text-sm">{userMsg}</p>}
            <button
              onClick={() =>
                updateUserMutation.mutate({
                  email: email !== profile.email ? email : undefined,
                  password: password || undefined,
                })
              }
              disabled={updateUserMutation.isPending}
              className="bg-black text-white rounded px-4 py-2 text-sm disabled:opacity-50"
            >
              저장
            </button>
          </div>
        </section>

        <section className="bg-white rounded-lg p-6 shadow-sm">
          <h2 className="font-semibold mb-4">모델</h2>
          <div className="space-y-2">
            {MODELS.map(m => (
              <label key={m.code} className="flex items-center gap-3 p-3 border rounded cursor-pointer hover:bg-gray-50">
                <input
                  type="radio"
                  name="model"
                  value={m.code}
                  checked={profile.model === m.code}
                  disabled={updateModelMutation.isPending}
                  onChange={() => updateModelMutation.mutate(m.code)}
                />
                <span className="text-sm">{m.name}</span>
              </label>
            ))}
            {modelMsg && <p className="text-green-600 text-sm">{modelMsg}</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
