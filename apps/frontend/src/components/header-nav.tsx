'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';

export function HeaderNav() {
  const [menuOpen, setMenuOpen] = useState(false);
  const router = useRouter();

  const handleLogout = async () => {
    await api.post('/auth/logout');
    router.replace('/login');
  };

  return (
    <header className="border-b bg-white px-4 py-3 flex items-center justify-between relative">
      <h1 className="font-bold text-lg">Bubbles</h1>
      <div className="flex items-center gap-4 text-sm">
        <Link href="/chat" className="text-gray-600 hover:text-black">채팅</Link>
        <Link href="/memory" className="text-gray-600 hover:text-black">메모리</Link>
        <div className="relative">
          <button onClick={() => setMenuOpen(v => !v)} className="text-gray-600 hover:text-black px-1">
            ⋮
          </button>
          {menuOpen && (
            <div className="absolute right-0 mt-2 w-32 bg-white border rounded-lg shadow-sm py-1 z-10">
              <Link
                href="/profile"
                className="block px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
                onClick={() => setMenuOpen(false)}
              >
                프로필
              </Link>
              <button
                onClick={handleLogout}
                className="block w-full text-left px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                로그아웃
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
