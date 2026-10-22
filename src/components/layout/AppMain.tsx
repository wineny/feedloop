'use client';

import type { ReactNode } from 'react';
import { usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

/**
 * 앱 본문 셸 — 내부 화면 v4(2026-09-17).
 *
 * 두 가지를 한다.
 *
 * ① **바탕색.** 내부 화면은 `--canvas`(#faf8f7) 위에 흰 카드를 올린다. 랜딩(`/`)과 로그인은
 *    자기 배경을 갖고 있으므로 흰 바탕 그대로 둔다 — `Navigation` 이 같은 두 경로에서 물러나는
 *    것과 같은 규칙이다. 서버 컴포넌트인 `layout.tsx` 는 경로를 모르므로 이 조각만 클라이언트다.
 *    ⚠️ 바탕은 **바깥 래퍼**가 칠한다. 가운데 1120 컨테이너에 칠하면 넓은 화면에서 양옆 여백만
 *    흰색으로 남아 띠처럼 보인다.
 *
 * ② **하단 여백.** 자기 위젯 fab(도그푸딩)이 `right:20 bottom:20 56px` 에 고정으로 떠 있어
 *    스크롤 끝에서 마지막 행·링크를 덮었다(`/monitor` 에서 실제로 행이 가려졌다).
 *    fab 56 + 바닥 여백 20 + 숨 쉴 틈 = 112px(`pb-28`). 위젯 자체는 안 건드린다 —
 *    `widget.js` 는 gzip 19KB 상한에 여유가 400B 남짓이라 손대면 크기부터 재야 한다.
 */
export function AppMain({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isChrome = pathname !== '/' && pathname !== '/login';

  return (
    /* `break-keep`(word-break: keep-all) — 한국어는 «단어» 안에서 꺾으면 안 된다.
       없으면 「…배지가 잘못된 가게에 표시 / 됨」 처럼 마지막 한 글자만 다음 줄로 떨어진다.
       `break-words`(overflow-wrap: break-word)를 함께 둬서, 긴 URL·해시처럼 끊을 수 없는
       토큰이 칸을 밀어낼 때만 예외적으로 끊기게 한다. 이메일 템플릿도 같은 규칙을 쓴다. */
    <div className={cn('flex flex-1 flex-col', isChrome && 'bg-canvas [word-break:keep-all] break-words')}>
      <main
        className={cn(
          'mx-auto w-full max-w-[1120px] flex-1 px-6',
          isChrome ? 'pt-10 pb-28 sm:pt-14 sm:pb-32' : 'py-7',
        )}
      >
        {children}
      </main>
    </div>
  );
}
