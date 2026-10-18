import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getServiceRoleClient } from "@/lib/supabase";
import { KAKAO_TOKEN_PLACEHOLDER } from "@/lib/bot/kakao-placeholder";
import { validateRegistrationInput } from "@/lib/bot/registration";
import { MAX_BOTS_PER_USER } from "@/lib/llm/limits";
import { listAccessibleBotIds } from "@/lib/auth/ownership";

// 계정당 봇 수 상한은 `lib/llm/limits.ts` 로 옮겼다(2026-09-18). 판정은 아래 POST 가 그대로 한다.
// 옮긴 이유: 랜딩 「확장」 섹션이 같은 숫자를 그려야 하는데, 이 파일에서 가져가면
// `next-auth`·`@/lib/supabase` 가 랜딩의 모듈 그래프에 딸려 온다. route.ts 는 핸들러만 내보낸다.

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getServiceRoleClient();
  // Owned bots plus the ones this user approves for (bot_members — the hackathon demo bot).
  // The header scope selector reads this list, so a judge who joined the demo bot sees it here too.
  const ids = await listAccessibleBotIds(session.user.id);
  if (ids.length === 0) {
    return NextResponse.json({ bots: [] });
  }
  // 연결 시각 셋(widget/channel_connected_at·last_active_at)은 대시보드 「피드백 채널」이
  // /bots 와 같은 판정을 내리기 위한 값이다(I-35). 타임스탬프뿐이고 암호문 컬럼은 여기 넣지 않는다.
  const { data: bots, error } = await supabase
    .from("bots")
    .select(
      "id, service_name, bot_username, status, platform, pr_mode, created_at, widget_connected_at, channel_connected_at, last_active_at",
    )
    .in("id", ids)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: "Failed to fetch bots" }, { status: 500 });
  }

  return NextResponse.json({ bots: bots ?? [] });
}

// 봇 등록의 기본 채널은 웹 위젯이다.
//
// 등록 시점에 우리가 할 수 있는 일은 레코드를 만드는 것뿐이고, 실제 연결은
// 다음 화면(/bots/[id]/connect)에서 끝난다 — 웹 위젯은 스크립트를 서비스에
// 붙이는 순간, 카카오톡(선택)은 발급한 스킬 서버 URL 을 오픈빌더에 붙이는
// 순간이다. 그래서 여기서는 활성화를 시도하지 않고 status='pending' 으로 두며,
// 첫 메시지 수신(위젯 POST 또는 카카오 웹훅)이 연결을 확정한다.
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "잘못된 요청 형식입니다" }, { status: 400 });
    }

    // 클라이언트 zod 는 우회되므로 서버가 다시 본다 — service_name 은 무인증 위젯 config 로 나가고,
    // github_repo_url 은 공용 GITHUB_TOKEN 이 향하는 곳이다(lib/bot/registration.ts 참고).
    const parsed = validateRegistrationInput(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const { service_name, service_description, service_url, github_repo_url, pr_mode } = parsed.values;

    const supabase = getServiceRoleClient();

    // 유저당 봇 개수 상한. 키 없는 봇은 «우리» 키로 하루 DEFAULT_LIMITS.noKey 건을 답하므로
    // (limits.ts) 봇을 무한히 만들 수 있으면 플랫폼 지출 상한이 사실상 없다 — 게이트가 Google 로그인
    // 하나뿐이라 봇 수가 곧 지출 승수다(2026-09-13 보안 리뷰 MEDIUM-1). 실사용은 계정당 1~2개.
    const { count: botCount, error: countError } = await supabase
      .from("bots")
      .select("id", { count: "exact", head: true })
      .eq("user_id", session.user.id);
    if (countError) {
      console.error("Error counting bots:", countError);
      return NextResponse.json({ error: "Failed to create bot" }, { status: 500 });
    }
    if ((botCount ?? 0) >= MAX_BOTS_PER_USER) {
      return NextResponse.json(
        { error: `서비스는 계정당 ${MAX_BOTS_PER_USER}개까지 등록할 수 있어요. 안 쓰는 서비스를 정리하거나 팀에 문의해 주세요` },
        { status: 400 },
      );
    }

    const { data, error } = await supabase
      .from("bots")
      .insert({
        user_id: session.user.id,
        // bot_token_encrypted 는 스키마상 NOT NULL 이라(init_schema.sql 41행,
        // 텔레그램만 있던 시절 컬럼) 웹 위젯 봇에도 자리표시자를 넣는다.
        // 카카오와 마찬가지로 위젯 경로는 이 값을 읽지 않는다.
        platform: "web",
        bot_token_encrypted: KAKAO_TOKEN_PLACEHOLDER,
        service_name,
        service_description,
        service_url,
        github_repo_url,
        pr_mode,
        status: "pending",
      })
      // 전체 행을 돌려주면 채널톡 자격증명·웹훅 토큰 같은 암호화 컬럼까지 응답에 실린다.
      // 지금은 새 봇이라 비어 있지만, 비어 있다는 사실에 기대는 건 방어가 아니다(원칙 4).
      .select('id, service_name, platform, pr_mode, status, created_at')
      .single();

    if (error) {
      console.error("Supabase insert error:", error);
      return NextResponse.json({ error: "Failed to create bot" }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("Create bot error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
