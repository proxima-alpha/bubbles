'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';

const MODELS = [
  { code: 'claude-opus-4-7', name: 'Claude Opus 4.7', provider: 'claude' },
  { code: 'gpt-4o-2024-08-06', name: 'GPT-4o', provider: 'gpt' },
];

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Anthropic (Claude)',
  gpt: 'OpenAI (GPT)',
};

interface UserProfile {
  email: string;
  model: string | null;
  providers: { provider: string; hasKey: boolean }[];
}

export default function ProfilePage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!localStorage.getItem('accessToken')) {
      router.replace('/login');
    }
  }, [router]);

  const { data: profile, isLoading } = useQuery<UserProfile>({
    queryKey: ['user'],
    queryFn: () => api.get('/user').then(r => r.data),
  });

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [licenseKeys, setLicenseKeys] = useState<Record<string, string>>({});
  const [userMsg, setUserMsg] = useState('');
  const [modelMsg, setModelMsg] = useState('');
  const [keyMsgs, setKeyMsgs] = useState<Record<string, string>>({});

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
    onError: () => {
      setModelMsg('해당 provider의 API 키를 먼저 등록해주세요.');
      setTimeout(() => setModelMsg(''), 3000);
    },
  });

  const updateKeyMutation = useMutation({
    mutationFn: ({ provider, key }: { provider: string; key: string }) =>
      api.put('/user/license-key', { provider, key }),
    onSuccess: (_, { provider }) => {
      queryClient.invalidateQueries({ queryKey: ['user'] });
      setLicenseKeys(prev => ({ ...prev, [provider]: '' }));
      setKeyMsgs(prev => ({ ...prev, [provider]: '저장되었습니다.' }));
      setTimeout(() => setKeyMsgs(prev => ({ ...prev, [provider]: '' })), 3000);
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
        {/* 계정 정보 */}
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

        {/* 모델 선택 */}
        <section className="bg-white rounded-lg p-6 shadow-sm">
          <h2 className="font-semibold mb-4">모델</h2>
          <div className="space-y-2">
            {MODELS.map(m => {
              const hasKey = profile.providers.find(p => p.provider === m.provider)?.hasKey;
              return (
                <label
                  key={m.code}
                  className={`flex items-center gap-3 p-3 border rounded cursor-pointer hover:bg-gray-50 ${
                    !hasKey ? 'opacity-50 cursor-not-allowed' : ''
                  }`}
                >
                  <input
                    type="radio"
                    name="model"
                    value={m.code}
                    checked={profile.model === m.code}
                    disabled={!hasKey || updateModelMutation.isPending}
                    onChange={() => updateModelMutation.mutate(m.code)}
                  />
                  <span className="text-sm flex-1">{m.name}</span>
                  {!hasKey && <span className="text-xs text-gray-400">API 키 필요</span>}
                </label>
              );
            })}
            {modelMsg && <p className="text-sm text-red-500">{modelMsg}</p>}
          </div>
        </section>

        {/* API 키 */}
        <section className="bg-white rounded-lg p-6 shadow-sm">
          <h2 className="font-semibold mb-4">API 키</h2>
          <div className="space-y-4">
            {profile.providers.map(({ provider, hasKey }) => (
              <div key={provider}>
                <label className="block text-sm font-medium mb-1">
                  {PROVIDER_LABELS[provider] ?? provider}
                  {hasKey && <span className="text-green-600 text-xs ml-2">등록됨</span>}
                </label>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={licenseKeys[provider] || ''}
                    onChange={e =>
                      setLicenseKeys(prev => ({ ...prev, [provider]: e.target.value }))
                    }
                    placeholder={hasKey ? '변경하려면 새 키 입력' : 'API 키 입력'}
                    className="flex-1 border rounded px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-black"
                  />
                  <button
                    onClick={() =>
                      updateKeyMutation.mutate({ provider, key: licenseKeys[provider] || '' })
                    }
                    disabled={!licenseKeys[provider] || updateKeyMutation.isPending}
                    className="bg-black text-white rounded px-3 py-2 text-sm disabled:opacity-50"
                  >
                    저장
                  </button>
                </div>
                {keyMsgs[provider] && (
                  <p className="text-green-600 text-xs mt-1">{keyMsgs[provider]}</p>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
