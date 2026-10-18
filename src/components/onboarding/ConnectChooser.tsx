// 연결 갈림길과 현황판 — 이 화면의 첫 장면.
//
// 예전엔 탭 셋(웹 위젯 · 채널톡 · 카카오톡)이었다. 탭은 **이미 무엇을 고를지 아는 사람**의
// 문법이라, 「웹 위젯」이라는 말만 보고는 그게 자기 것인지 모르는 운영자를 지나친다.
// 그래서 카드 제목을 채널 이름이 아니라 **그 사람의 상황**으로 적는다 — 채널 이름은
// 마크 옆 작은 라벨로 내려간다.
//
// 위젯이 먼저 오고 주 버튼(코랄)을 갖는 이유는 취향이 아니다. 채널톡 경로에서 우리는
// 분류와 되돌림만 하고(`lib/channel/store.ts`) AI 즉답·답변 지식·상담원 연결·BYOK·
// 대화 맥락이 전부 안 돈다. 같은 서비스라도 위젯 쪽이 훨씬 많은 일을 한다.
// 그렇다고 채널톡을 아래로 내리지는 않는다 — 이미 채널톡 유료를 쓰는 회사에겐 코드 수정 0 이라
// 여전히 가장 빠른 길이고, 옆 카드 제목이 그 상황을 그대로 말해 준다.
//
// 한 번이라도 연결된 뒤에는 같은 질문을 다시 하지 않는다. 갈림길이 **현황판**으로 바뀌고
// 줄마다 다음 행동 하나씩을 갖는다.
//
// 2026-09-20 — **입구는 한 번에 하나다**(`lib/connect/exclusive.ts`). 예전엔 이 화면이
// 「둘 다 붙여도 됩니다」라고 권했는데, 두 입구가 같은 제품을 주지 않아서(위 문단) 같은
// 서비스 손님이 들어온 문에 따라 다른 Feedloop 을 보게 됐다. 이제 한쪽이 켜지면 반대쪽
// 카드는 잠기고, 갈아타려면 쓰던 쪽을 먼저 내린다.

import type { ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { RiChat1Line } from 'react-icons/ri';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { lastFeedbackLabel } from '@/lib/connect/last-feedback';
import { ENTRANCE_NAME, type Entrance } from '@/lib/connect/exclusive';
import { DisconnectButton } from '@/components/onboarding/DisconnectButton';

/** 위젯 쪽은 우리 것이라 잉크 사각형, 채널톡은 공식 마크(스쿼클이 자기 배경을 갖고 있다) */
function ChannelMark({ kind }: { kind: 'widget' | 'channel' }) {
  if (kind === 'widget') {
    return (
      <span className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] bg-foreground text-background">
        <RiChat1Line className="h-4 w-4" aria-hidden />
      </span>
    );
  }
  return (
    <span className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center overflow-hidden rounded-[9px]">
      <Image src="/channeltalk-mark.png" alt="" width={30} height={30} aria-hidden />
    </span>
  );
}

function MarkRow({ kind, name }: { kind: 'widget' | 'channel'; name: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <ChannelMark kind={kind} />
      <span className="text-[12.5px] font-semibold text-muted-foreground">{name}</span>
    </div>
  );
}

/** 갈림길·현황판이 공유하는 카드. `on` 이면 코랄 테두리 + 틴트로 「이쪽이 살아 있다」를 말한다. */
function ChoiceCard({
  kind,
  name,
  on,
  children,
}: {
  kind: 'widget' | 'channel';
  name: string;
  on?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2.5 rounded-[14px] border p-5',
        on ? 'border-primary bg-brand-subtle' : 'border-border-strong bg-background',
      )}
    >
      <MarkRow kind={kind} name={name} />
      {children}
    </div>
  );
}

function CardTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-[17px] font-bold leading-snug tracking-[-0.015em] text-balance">
      {children}
    </h3>
  );
}

function CardBody({ children }: { children: ReactNode }) {
  return <p className="text-[13.5px] leading-relaxed text-muted-foreground">{children}</p>;
}

/**
 * 「이게 있어야 됩니다」 — 고르기 전에 알아야 할 전제. 헤어라인 아래 작게 둔다.
 *
 * `mt-auto` 로 바닥에 붙인다. 두 카드는 grid 라 같은 높이인데, 본문 길이가 달라서
 * 그냥 두면 전제와 버튼이 서로 다른 높이에 서고 한쪽 카드 아래만 크게 빈다.
 */
function CardNeed({ children }: { children: ReactNode }) {
  return (
    <p className="mt-auto border-t border-border pt-3 text-[12.5px] leading-relaxed text-faint">
      {children}
    </p>
  );
}

/**
 * 카드의 행동 줄.
 *
 * `push` 는 **전제(`CardNeed`)가 없는 카드에서만** 켠다. 둘 다 `mt-auto` 면 플렉스박스가 남은
 * 공간을 두 auto 마진에 균등 분배해서, 전제 헤어라인이 버튼 위에 붙지 않고 중간에 뜬다.
 * 전제가 있는 카드는 그 전제가 이미 바닥으로 밀려 있으므로 버튼은 따라오기만 하면 된다.
 */
function CardActions({ push, children }: { push?: boolean; children: ReactNode }) {
  return (
    <div className={cn('flex flex-wrap gap-2 pt-1.5', push && 'mt-auto')}>{children}</div>
  );
}

function StateLine({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <p
      className={cn(
        'inline-flex items-center gap-2 text-[13px]',
        on ? 'font-semibold text-brand-strong' : 'text-faint',
      )}
    >
      <i
        className={cn('block h-1.5 w-1.5 rounded-full', on ? 'bg-primary' : 'bg-faint')}
        aria-hidden
      />
      {children}
    </p>
  );
}

const CHANNEL_NEED = '채널톡 유료 플랜이 있어야 API 키를 발급할 수 있어요 · 3단계';

/* ─────────────────────────────────────────────────────────────
   화면 1 — 갈림길. 아직 아무 입구도 열리지 않았을 때.
   ───────────────────────────────────────────────────────────── */

/**
 * `dailyLimit`·`dailyLimitOverridden` 은 llm-key GET 과 같은 모양이다(`null` = 한도 없음).
 * 아래 안내 문장이 이 값을 쓴다 — 「하루 100건까지 무료」를 박아 두면 상한 예외 봇(데모 2000)과
 * 키를 넣은 봇에게 거짓말이 된다(I-26).
 */
export function ConnectChooser({
  botId,
  dailyLimit,
  dailyLimitOverridden,
}: {
  botId: string;
  dailyLimit: number | null;
  dailyLimitOverridden: boolean;
}) {
  return (
    <div className="flex max-w-[860px] flex-col gap-4">
      <p className="text-[15px] font-bold tracking-[-0.01em]">
        지금 고객 문의를 어떻게 받고 계세요?
      </p>

      <div className="grid gap-3.5 sm:grid-cols-2">
        <ChoiceCard kind="widget" name="Feedloop 웹 위젯">
          <CardTitle>상담 챗봇이 없어요. 새로 붙일래요</CardTitle>
          <CardBody>
            서비스에 말풍선을 띄웁니다. 방문자가 남긴 말에 AI가 그 자리에서 답하고, 모르는 건
            담당자에게 넘깁니다. 고친 게 반영되면 그 방문자에게 바로 알려줘요.
          </CardBody>
          <CardNeed>서비스에 코드 한 줄을 붙일 수 있으면 됩니다 · 1단계</CardNeed>
          <CardActions>
            <Button asChild>
              <Link href={`/bots/${botId}/connect?via=widget`}>위젯 붙이기</Link>
            </Button>
          </CardActions>
        </ChoiceCard>

        <ChoiceCard kind="channel" name="채널톡">
          <CardTitle>이미 채널톡을 쓰고 있어요</CardTitle>
          <CardBody>
            쓰던 상담창에 그대로 붙습니다. 들어온 문의를 Feedloop 이 읽어 분류하고, 답은 지금처럼
            상담원이 합니다.
          </CardBody>
          <CardNeed>{CHANNEL_NEED}</CardNeed>
          <CardActions>
            <Button asChild variant="outline">
              <Link href={`/bots/${botId}/connect?via=channel`}>채널톡 연결하기</Link>
            </Button>
          </CardActions>
        </ChoiceCard>
      </div>

      <p className="max-w-[66ch] border-t border-border pt-4 text-[12.5px] leading-relaxed text-muted-foreground">
        <b className="font-semibold text-foreground">한 서비스에 한 곳만 붙습니다.</b> 나중에 마음이
        바뀌면 쓰던 쪽을 「연결 해제」로 내리고 반대쪽을 붙이면 돼요. AI 답변은 어느 쪽이든{' '}
        {dailyLimit === null ? (
          <>
            <b className="font-semibold text-foreground">내 API 키로 한도 없이</b> 나가고, 요금은 그 키로 청구됩니다.
          </>
        ) : (
          <>
            <b className="font-semibold text-foreground">
              하루 {dailyLimit.toLocaleString('ko-KR')}건까지{dailyLimitOverridden ? '' : ' 무료'}
            </b>
            {/* 상한 예외 봇은 키를 넣어도 예외가 이긴다 — 「키를 넣으면 한도가 없다」는 그 운영자에게 거짓말 */}
            {dailyLimitOverridden ? '예요.' : '이고, 내 API 키를 넣으면 한도가 없습니다.'}
          </>
        )}
      </p>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   화면 7 — 잠김. 쓰던 입구가 있는데 반대쪽 안내로 들어왔을 때.
   ───────────────────────────────────────────────────────────── */

/**
 * 「이쪽은 지금 못 붙입니다」를 안내 «대신» 그린다.
 *
 * 주소창으로 들어오는 길을 막는 자리다. 카드의 버튼만 없애면 `?via=channel` 을 직접 쳐서
 * 세 단계를 다 채운 뒤 저장에서 400 을 만난다 — 그건 잠금이 아니라 함정이다.
 *
 * 되돌릴 방법을 같은 화면에 둔다. 「그럼 어떡하냐」를 다른 화면에서 찾게 하지 않는다.
 */
export function ConnectLocked({
  botId,
  want,
  using,
}: {
  botId: string;
  want: Entrance;
  using: Entrance;
}) {
  return (
    <div className="flex max-w-[560px] flex-col gap-3.5 rounded-[14px] border border-border-strong bg-background p-6">
      <MarkRow kind={using} name={ENTRANCE_NAME[using]} />
      <CardTitle>이미 {ENTRANCE_NAME[using]}으로 받고 있어요</CardTitle>
      <CardBody>
        한 서비스에는 입구를 하나만 둡니다. 같은 손님이 두 문으로 들어오면 어느 쪽으로 답했는지
        기록이 갈라지고, 두 입구가 주는 기능도 서로 달라요.
      </CardBody>
      <CardBody>
        {ENTRANCE_NAME[want]}으로 옮기시려면 «서비스에 연결» 화면에서 {ENTRANCE_NAME[using]}을 먼저
        「연결 해제」하세요. 그동안 쌓인 대화와 피드백은 지워지지 않습니다.
        {/* 위젯은 서버가 내릴 수 없다 — 스크립트가 남아 있으면 다음 방문자가 되살린다.
            순서를 안 알려주면 해제하자마자 다시 켜져서 이 화면으로 돌아온다 */}
        {using === 'widget' && ' 서비스 코드에서 위젯 스크립트 한 줄을 지우는 게 먼저예요.'}
      </CardBody>
      <CardActions>
        <Button asChild>
          <Link href={`/bots/${botId}/connect`}>서비스에 연결로 가기</Link>
        </Button>
      </CardActions>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   화면 6 — 현황판. 한 번이라도 연결된 뒤 다시 왔을 때.
   ───────────────────────────────────────────────────────────── */

/**
 * 현황판에서 «안 쓰는 쪽» 카드.
 *
 * 입구는 한 번에 하나라(`lib/connect/exclusive.ts`) 현황판에 꺼진 카드가 있다는 건
 * 곧 반대쪽이 쓰이고 있다는 뜻이다 — 둘 다 꺼진 봇은 애초에 갈림길로 간다.
 *
 * 버튼을 비활성으로 두지 않고 아예 빼는 이유: 비활성 버튼은 「왜 안 눌리지」를 남긴다.
 * 대신 다음 행동을 문장으로 적는다 — 그 행동이 이 카드가 아니라 **옆 카드**에 있기 때문이다.
 */
function LockedSide({ want, using }: { want: Entrance; using: Entrance }) {
  return (
    <>
      <StateLine on={false}>지금은 못 붙여요</StateLine>
      <CardTitle>{ENTRANCE_NAME[using]}을 쓰는 중이에요</CardTitle>
      <CardBody>
        한 서비스에는 입구를 하나만 둡니다. {ENTRANCE_NAME[want]}으로 옮기시려면 옆의{' '}
        <b className="font-semibold text-foreground">「연결 해제」</b>로 {ENTRANCE_NAME[using]}을
        먼저 내려 주세요.
      </CardBody>
    </>
  );
}

export interface ChannelState {
  on: boolean;
  /** 그 입구로 마지막 피드백이 들어온 시각(ISO). 아직 없으면 null */
  lastAt: string | null;
}

export function ConnectOverview({
  botId,
  widget,
  channel,
  appearanceHref,
}: {
  botId: string;
  widget: ChannelState;
  channel: ChannelState;
  appearanceHref: string;
}) {
  return (
    <div className="flex max-w-[860px] flex-col gap-4">
      <div className="grid gap-3.5 sm:grid-cols-2">
        <ChoiceCard kind="widget" name="Feedloop 웹 위젯" on={widget.on}>
          {widget.on ? (
            <>
              <StateLine on>연결됨</StateLine>
              <CardTitle>{lastFeedbackLabel(widget.lastAt)}</CardTitle>
              <CardActions push>
                {/* 붙인 뒤에도 스니펫으로 돌아갈 길을 남긴다 — 다른 페이지나 다른 빌드에
                    또 붙일 일이 있다. 채널톡 카드의 「연결 설정」과 같은 자리다 */}
                <Button asChild variant="outline" size="sm">
                  <Link href={`/bots/${botId}/connect?via=widget`}>스크립트 보기</Link>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link href={appearanceHref}>모양 바꾸기</Link>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link href="/inbox">대화 보기</Link>
                </Button>
                {/* I-25 — 표시만 내린다. 스크립트가 남아 있으면 다음 방문자가 열 때 다시 켜진다 */}
                <DisconnectButton botId={botId} kind="widget" />
              </CardActions>
            </>
          ) : (
            <LockedSide want="widget" using="channel" />
          )}
        </ChoiceCard>

        <ChoiceCard kind="channel" name="채널톡" on={channel.on}>
          {channel.on ? (
            <>
              <StateLine on>연결됨</StateLine>
              <CardTitle>{lastFeedbackLabel(channel.lastAt)}</CardTitle>
              <CardActions push>
                <Button asChild variant="outline" size="sm">
                  <Link href={`/bots/${botId}/connect?via=channel`}>연결 설정</Link>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link href="/inbox">대화 보기</Link>
                </Button>
                {/* I-25 — 키·웹훅 주소를 지우고 채널톡 대화의 실명·연락처를 익명화한다(U6) */}
                <DisconnectButton botId={botId} kind="channel" />
              </CardActions>
            </>
          ) : (
            <LockedSide want="channel" using="widget" />
          )}
        </ChoiceCard>
      </div>

      {/* 「스크립트를 지우면 꺼진다」고 쓰지 않는다 — 그렇게 동작하지 않는다. 내리는 건 사람이 「연결 해제」로 한다(I-25) */}
      <p className="max-w-[66ch] border-t border-border pt-4 text-[12.5px] leading-relaxed text-muted-foreground">
        연결 표시는 한 번이라도 들어오면 계속 남습니다. 스크립트를 지우거나 웹훅을 내려도 자동으로 꺼지지는
        않아요 — 그때는 카드의 「연결 해제」로 내리세요. 서비스 자체를 지우려면 「챗봇 설정」 목록에서 합니다.
      </p>
    </div>
  );
}
