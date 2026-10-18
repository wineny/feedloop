// 설치 콜백이 봇을 못 정한 채 돌아왔을 때(예: state 없이 GitHub 에서 바로 Install) 목록 화면이 띄우는 한 줄.
//
// 왜 필요한가: 콜백은 결과를 `?app=` 으로만 말한다. 봇이 정해지면 그 봇의 GitHub 탭이 읽지만,
// 못 정하면 `/bots` 로 온다 — 그 화면이 이 값을 안 읽으면 **운영자는 아무 안내도 못 받는다**
// (설치는 GitHub 쪽에 실제로 생겼는데 화면은 그대로다). 코드 리뷰 HIGH 로 잡힌 자리다.
//
// 서버 컴포넌트다. 문구는 `lib/github/app-state-types.ts` 한 곳에서 오고, 봇 상세 화면도 같은 목록을 쓴다.

import { callbackBanner } from '@/lib/github/app-state-types';

const TONE = {
  ok: 'border-emerald-600/30 bg-emerald-50 text-emerald-900',
  info: 'border-border-strong bg-muted text-foreground',
  error: 'border-amber-600/30 bg-amber-50 text-amber-900',
} as const;

export function InstallResultBanner({ app }: { app?: string | string[] }) {
  const raw = Array.isArray(app) ? app[0] : app;
  const banner = callbackBanner(raw);
  if (!banner) return null;
  // 바깥 여백은 부모의 gap 이 준다 — v4 는 radius 한 종류(16)·본문 14
  return (
    <div className={`rounded-2xl border px-5 py-3.5 text-sm leading-relaxed ${TONE[banner.kind]}`} role="status">
      {banner.message}
    </div>
  );
}
