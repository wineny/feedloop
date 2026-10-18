'use client';

import { signIn, signOut, useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";
import { GoogleMark } from "./GoogleMark";

export function AuthButton() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return <span className="h-9 w-[132px] animate-pulse rounded-[12px] bg-muted" aria-hidden />;
  }

  if (session && session.user) {
    return (
      <div className="flex items-center gap-2">
        <span className="hidden text-sm text-muted-foreground sm:inline-block">
          {session.user.name}님
        </span>
        <Button
          variant="ghost"
          size="sm"
          // 로그아웃하면 랜딩으로. 기본값(현재 페이지 유지)이면 방금 보던 실데이터 자리에 예시 데이터가 그대로 덮여 헷갈린다.
          onClick={() => signOut({ callbackUrl: '/' })}
          className="text-muted-foreground hover:text-foreground"
        >
          <LogOut className="mr-1.5 h-4 w-4" />
          로그아웃
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
      Google로 시작
    </Button>
  );
}
