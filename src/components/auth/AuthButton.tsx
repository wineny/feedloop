'use client';

import { signIn, signOut, useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";
import { useTranslations } from "next-intl";
import { GoogleMark } from "./GoogleMark";

export function AuthButton() {
  const t = useTranslations("auth");
  const { data: session, status } = useSession();

  if (status === "loading") {
    return <span className="h-9 w-[132px] animate-pulse rounded-[12px] bg-muted" aria-hidden />;
  }

  if (session && session.user) {
    return (
      <div className="flex items-center gap-2">
        <span className="hidden text-sm text-muted-foreground sm:inline-block">
          {t('userName', { name: session.user.name ?? '' })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          // 로그아웃하면 랜딩으로. 기본값(현재 페이지 유지)이면 방금 보던 실데이터 자리에 예시 데이터가 그대로 덮여 헷갈린다.
          onClick={() => signOut({ callbackUrl: '/' })}
          className="text-muted-foreground hover:text-foreground"
        >
          <LogOut className="mr-1.5 h-4 w-4" />
          {t('logout')}
        </Button>
      </div>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => signIn("google")}
      className="gap-2 font-semibold"
    >
      <GoogleMark />
      {/* 폰 폭(<640px)은 머리줄 오른쪽이 «화면 − 로고 140px» 뿐이라 긴 문구가 넘친다(375px 에서 37px) → 짧게 */}
      <span className="sm:hidden">{t('startWithGoogleShort')}</span>
      <span className="hidden sm:inline">{t('startWithGoogle')}</span>
    </Button>
  );
}
