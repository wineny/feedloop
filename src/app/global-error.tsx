'use client';

// 마지막 그물 — 루트 레이아웃 자체가 실패했을 때 뜬다. 레이아웃이 없는 자리라 `<html>`·`<body>`
// 를 직접 그려야 하고, 전역 CSS(Tailwind)가 실려 있다는 보장이 없어 스타일은 인라인으로 박는다.
// 여기까지 왔다는 건 화면이 통째로 날아갔다는 뜻이므로 문구는 최대한 짧게.

import { useEffect, useState } from 'react';
import { reloadOnceForStaleBuild } from '@/lib/stale-build';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // 상태를 이펙트에서 세우지 않는다(react-hooks/set-state-in-effect). 첫 렌더에 한 번
  // 판단하고 끝낸다 — 새로고침이 거절되면(방금 이미 했다) false 라 아래 오류 화면이 그대로 뜬다.
  const [recovering] = useState(() => reloadOnceForStaleBuild(error));

  useEffect(() => {
    console.error('[feedloop] 전역 오류', error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#ffffff',
          color: '#1b1614',
          fontFamily:
            'Pretendard, -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", system-ui, sans-serif',
        }}
      >
        <div style={{ maxWidth: 420, padding: 24, textAlign: 'center' }}>
          {recovering ? (
            <p style={{ margin: 0, fontSize: 14, color: '#6b625d' }}>
              Loading the new version…
            </p>
          ) : (
            <>
              <h1 style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 700 }}>
                This page could not be loaded
              </h1>
              <p style={{ margin: '0 0 20px', fontSize: 14, lineHeight: 1.7, color: '#6b625d' }}>
                This may be a brief glitch. Reloading usually fixes it.
              </p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button type="button" onClick={reset} style={primaryButton}>
                  Try again
                </button>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  style={outlineButton}
                >
                  Reload
                </button>
              </div>
              {error.digest && (
                <p style={{ margin: '16px 0 0', fontSize: 12, color: '#9a918c' }}>
                  Error ID {error.digest}
                </p>
              )}
            </>
          )}
        </div>
      </body>
    </html>
  );
}

const baseButton: React.CSSProperties = {
  height: 40,
  padding: '0 18px',
  borderRadius: 999,
  fontSize: 14,
  cursor: 'pointer',
};

const primaryButton: React.CSSProperties = {
  ...baseButton,
  border: 'none',
  background: '#F2645C',
  color: '#ffffff',
  fontWeight: 600,
};

const outlineButton: React.CSSProperties = {
  ...baseButton,
  border: '1px solid #ddd5d1',
  background: 'transparent',
  color: '#1b1614',
  fontWeight: 500,
};
