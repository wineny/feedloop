'use client';

// 화면 하나가 그리다 실패했을 때 대신 뜨는 자리. 이게 없으면 Next 의 영문 기본 화면
// (「This page couldn't load」)이 그대로 뜬다 — 심사위원이 볼 수도 있는 화면이라 우리 말로 받는다.
// 헤더·바탕은 루트 레이아웃이 그대로 두르므로, 여기서는 본문만 그린다.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { reloadOnceForStaleBuild } from '@/lib/stale-build';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('common');
  // 배포가 바뀌어 난 오류면 스스로 새로고침한다. 그동안은 오류 문구 대신 「다시 불러오는 중」을 보여준다 —
  // 어차피 1초 뒤 사라질 화면에 사용자가 놀랄 이유가 없다.
  // 상태를 이펙트에서 세우지 않는다(react-hooks/set-state-in-effect). 첫 렌더에 한 번
  // 판단하고 끝낸다 — 새로고침이 거절되면(방금 이미 했다) false 라 아래 오류 화면이 그대로 뜬다.
  const [recovering] = useState(() => reloadOnceForStaleBuild(error));

  useEffect(() => {
    console.error('[feedloop] 화면 오류', error);
  }, [error]);

  if (recovering) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('recovering')}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-[50vh] max-w-lg flex-col items-center justify-center gap-4 text-center">
      <h1 className="text-xl font-bold text-foreground">{t('errorTitle')}</h1>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {t('errorBody')}
      </p>
      <div className="flex items-center gap-2">
        <Button onClick={reset}>{t('retry')}</Button>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t('reload')}
        </Button>
        <Button variant="ghost" asChild>
          <Link href="/">{t('home')}</Link>
        </Button>
      </div>
      {error.digest && <p className="text-xs text-muted-foreground">{t('errorDigest', { digest: error.digest })}</p>}
    </div>
  );
}
