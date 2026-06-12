'use client';

import { useEffect } from 'react';

export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 text-center">
      <h1 className="text-2xl font-bold text-gray-800">오류가 발생했습니다</h1>
      <p className="text-gray-500 text-sm">서버에서 오류가 발생했습니다. 잠시 후 다시 시도해주세요.</p>
      <button
        onClick={reset}
        className="mt-2 px-4 py-2 bg-black text-white text-sm rounded hover:bg-gray-800"
      >
        다시 시도
      </button>
    </div>
  );
}
