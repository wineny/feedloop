// 언어가 정해지지 않는 404 — proxy 를 안 거치는 점(.) 든 경로(`/nope.txt`)가 여기로 온다.
// 레이아웃이 없는 자리라 <html>·<body> 를 직접 그린다. 사전도 못 읽으니 영어 고정.
export default function GlobalNotFound() {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
          color: '#1b1614',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>Page not found</h1>
          <p style={{ fontSize: 14, margin: 0, color: '#6b625d' }}>
            The page you are looking for does not exist or has moved.
          </p>
        </div>
      </body>
    </html>
  );
}
