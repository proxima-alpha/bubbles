'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';

const MODELS = [
  { code: 'claude-opus-4-7', name: 'Claude Opus 4.7', provider: 'claude' },
  { code: 'gpt-4o-2024-08-06', name: 'GPT-4o', provider: 'gpt' },
];

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Anthropic API 키',
  gpt: 'OpenAI API 키',
};

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [model, setModel] = useState('');
  const [licenseKeys, setLicenseKeys] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const selectedModel = MODELS.find(m => m.code === model);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedModel) return;
    setLoading(true);
    setError('');
    try {
      const { data } = await api.post('/auth/register', {
        email,
        password,
        model,
        licenseKeys: [{ provider: selectedModel.provider, key: licenseKeys[selectedModel.provider] || '' }],
      });
      localStorage.setItem('accessToken', data.accessToken);
      router.push('/chat');
    } catch (err: unknown) {
      const message = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setError(message || '회원가입 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm p-8 bg-white rounded-lg shadow">
        <h1 className="text-2xl font-bold mb-6">회원가입</h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">이메일</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-black"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">비밀번호</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-black"
              minLength={8}
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">모델 선택</label>
            <select
              value={model}
              onChange={e => setModel(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-black"
              required
            >
              <option value="">선택하세요</option>
              {MODELS.map(m => (
                <option key={m.code} value={m.code}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          {selectedModel && (
            <div>
              <label className="block text-sm font-medium mb-1">
                {PROVIDER_LABELS[selectedModel.provider]}
              </label>
              <input
                type="password"
                value={licenseKeys[selectedModel.provider] || ''}
                onChange={e =>
                  setLicenseKeys(prev => ({ ...prev, [selectedModel.provider]: e.target.value }))
                }
                placeholder="sk-..."
                className="w-full border rounded px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-black"
                required
              />
            </div>
          )}
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-black text-white rounded py-2 text-sm font-medium disabled:opacity-50"
          >
            {loading ? '처리 중...' : '회원가입'}
          </button>
        </form>
        <p className="mt-4 text-sm text-center text-gray-600">
          이미 계정이 있으신가요?{' '}
          <Link href="/login" className="text-black underline">
            로그인
          </Link>
        </p>
      </div>
    </div>
  );
}
