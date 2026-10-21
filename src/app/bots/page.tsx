import { getServiceRoleClient } from '@/lib/supabase';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import Link from 'next/link';
import { headers } from 'next/headers';
import { RiChat1Line, RiCustomerService2Line } from 'react-icons/ri';
import { Button } from '@/components/ui/button';
import { InstallResultBanner } from '@/components/github/InstallResultBanner';
import { PageHero, PAGE_EMOJI } from '@/components/layout/PageHero';
import { PrModeControl, type PrMode } from '@/components/bots/PrModeControl';
import { DeleteBotButton } from '@/components/bots/DeleteBotButton';
import { defaultGreeting, defaultOperatorName } from '@/lib/bot/appearance';
import { knowledgeSize, type FaqItem } from '@/lib/bot/knowledge';
import { isLlmProvider, PROVIDER_LABELS } from '@/lib/llm/models';
import { effectiveModelId } from '@/lib/llm/key';
import { DEFAULT_LIMITS, PLATFORM_MODEL_LABEL } from '@/lib/llm/limits';
import { cn } from '@/lib/utils';
import { sourceLabel } from '@/lib/channel/labels';
import { ScopedBotRow, ScopedBotsSummary, ScopedWidgetSnippet } from '@/components/bots/ScopedBots';
import { listAccessibleBots } from '@/lib/auth/ownership';
import { APPROVER_BOT_COLUMNS, toApproverView, type ApproverBotView } from '@/lib/bot/bot-list';
import { TryDemoBotButton } from './TryDemoBotButton';

// 「챗봇 설정」 — 등록 단위는 봇이 아니라 피드백을 받을 서비스다.
// 이름은 2026-09-20 에 「연결 서비스」에서 옮겼다. 이 화면이 실제로 하는 일이 «그 서비스에 붙인
// 챗봇을 설정하는 것»(입구·저장소·위젯 모양·답변 지식·API 키)이고, 헤더에서 서비스를 고르면
// 그 하나만 남기도록 바뀌면서 「목록」보다 「설정」이 맞는 이름이 됐다.
// 행 안은 입구 · 고칠 레포 · 위젯 모양 · 답변 지식 네 칸.
// v4(2026-09-17): 행마다 `.card-surface` 한 장. v2 는 헤어라인으로만 갈라 서비스 여럿이 한 덩어리로
// 뭉쳤다 — 바탕이 --canvas 라 흰 카드가 그림자 없이 떠오른다. 글자는 14(본문)/12.5(메타) 둘뿐.
//
// 칸 하나 = 「지금 상태」 + 「그 상태를 바꾸는 링크 하나」. 예전엔 링크가 행 오른쪽에
// 「연결」「위젯 모양」「답변 지식」으로 따로 모여 있어 어느 정보를 바꾸는 버튼인지 보이지 않았다.
// 링크 문구는 동사로 끝낸다 — 누르면 무엇을 하게 되는지 이름이 말하게.
//
// 배치(2026-09-10, .omc/plans/bots-visual.md): 행은 「상태 열(340) | 나머지 3칸」이다.
// 이 화면이 먼저 답할 것은 ① 피드백이 들어오는 상태인가 ② 막힌 것이 있는가 ③ 그 다음 나머지 —
// 그래서 이름과 입구를 왼쪽에 크게 두고, 비어 있어서 다음에 할 일인 링크만 코랄로 둔다.
// 이미 있는 걸 바꾸는 링크는 잉크다. 넷이 다 코랄이면 아무것도 두드러지지 않는다.

/**
 * DB 에서 읽는 컬럼. 키 존재 여부는 `llm_key_last4` 로 안다(키와 같이 저장·삭제된다) — 암호문은 아예 읽지 않는다.
 * 채널톡도 같다 — 연결 여부는 `channel_connected_at` 으로 알고, 자격증명·웹훅 토큰 암호문은 읽지 않는다.
 * 한 줄 리터럴이어야 supabase 타입 추론이 된다.
 */
const BOT_COLUMNS =
  'id, service_name, service_url, service_description, status, pr_mode, github_repo_url, widget_connected_at, last_active_at, channel_connected_at, display_name, greeting, operator_display_name, knowledge_text, knowledge_faq, llm_provider, llm_model, llm_key_last4, llm_key_failed_at, daily_reply_limit, github_token_last4, github_token_failed_at, github_token_broad, github_installation_id, github_installation_login, github_installation_lost_at, created_at, user_id';

interface BotRow {
  id: string;
  /** owner. Rows this user merely approves for (bot_members) have someone else's id here */
  user_id: string;
  service_name: string;
  service_url: string | null;
  service_description: string | null;
  status: string;
  pr_mode: string | null;
  github_repo_url: string | null;
  widget_connected_at: string | null;
  last_active_at: string | null;
  channel_connected_at: string | null;
  display_name: string | null;
  greeting: string | null;
  operator_display_name: string | null;
  knowledge_text: string | null;
  knowledge_faq: unknown;
  llm_provider: string | null;
  llm_model: string | null;
  llm_key_last4: string | null;
  /** 즉답 LLM 호출이 마지막으로 실패한 시각. 있으면 운영자가 키·모델을 고쳐야 한다. */
  llm_key_failed_at: string | null;
  /** provider·키 유무와 무관하게 이기는 예외 상한(데모 봇 2000 등). NULL 이면 기본값을 쓴다. */
  daily_reply_limit: number | null;
  /** 봇 GitHub 토큰(B5). 존재 여부는 last4 로만 안다 — 암호문은 읽지 않는다 */
  github_token_last4: string | null;
  github_token_failed_at: string | null;
  github_token_broad: boolean | null;
  /** GitHub App 설치(20260913_07). 비밀이 아니다 — 설치 id 와 계정 이름뿐. bigint 라 문자열로 올 수 있다 */
  github_installation_id: number | string | null;
  github_installation_login: string | null;
  github_installation_lost_at: string | null;
  created_at: string;
}

/** 화면이 쓰는 모양. 키는 있다/없다(`hasLlmKey`)만 남는다. */
interface BotView {
  id: string;
  service_name: string;
  service_url: string | null;
  service_description: string | null;
  status: string;
  pr_mode: string | null;
  github_repo_url: string | null;
  widget_connected_at: string | null;
  last_active_at: string | null;
  channel_connected_at: string | null;
  display_name: string | null;
  greeting: string | null;
  operator_display_name: string | null;
  knowledge_text: string | null;
  knowledge_faq: FaqItem[];
  llm_provider: string | null;
  llm_model: string | null;
  hasLlmKey: boolean;
  llm_key_failed_at: string | null;
  daily_reply_limit: number | null;
  /** 봇 GitHub 토큰 마지막 4자(B5). null = 공용 계정으로 시도 */
  github_token_last4: string | null;
  github_token_failed_at: string | null;
  /** 계정 전체 레포에 닿는 토큰인가(classic·OAuth). 사고 때 어느 봇부터 볼지 말해 준다 */
  github_token_broad: boolean | null;
  /** GitHub App 설치에 묶여 있는가. 토큰보다 «우선»한다 — 둘 다 있으면 앱이 PR 을 연다 */
  github_installation_id: number | string | null;
  github_installation_login: string | null;
  /** 설치가 사라졌거나 정지된 시각(웹훅이 적는다). 있으면 앱 경로가 죽어 있다 */
  github_installation_lost_at: string | null;
  created_at: string;
}

function toView(row: BotRow): BotView {
  const { llm_key_last4, knowledge_faq, ...rest } = row;
  return {
    ...rest,
    knowledge_faq: Array.isArray(knowledge_faq) ? (knowledge_faq as FaqItem[]) : [],
    hasLlmKey: Boolean(llm_key_last4),
  };
}

const demoBots: BotView[] = [
  {
    id: 'demo-bot-1',
    service_name: 'rona.so',
    service_url: 'https://rona.so',
    service_description: 'rona.so 커뮤니티 피드백 수집 및 AI 분류',
    status: 'active',
    pr_mode: 'approve',
    github_repo_url: 'https://github.com/example/rona',
    widget_connected_at: '2026-03-25T09:10:00Z',
    last_active_at: null,
    channel_connected_at: null,
    display_name: '로나',
    greeting: '안녕하세요! 로나를 쓰다 불편한 점이 있으면 알려주세요.',
    operator_display_name: null,
    knowledge_text: '로나는 실무형 AI 코칭 서비스입니다. 결제는 월 단위이고 환불은 7일 이내 전액입니다.',
    knowledge_faq: [
      {
        q: '환불은 어떻게 하나요?',
        a: '결제 7일 이내면 설정 > 결제에서 전액 환불됩니다.',
      },
      {
        q: '코칭 시간은 언제인가요?',
        a: '평일 오전 10시부터 오후 7시까지 예약할 수 있어요.',
      },
    ],
    llm_provider: 'anthropic',
    llm_model: null,
    hasLlmKey: true,
    llm_key_failed_at: null,
    daily_reply_limit: null,
    github_token_last4: 'k9Qz',
    github_token_failed_at: null,
    github_token_broad: false,
    // 앱 설치와 토큰이 둘 다 있는 봇 — 앱이 우선이고 토큰은 꼬리로 붙는다(심사 기본 화면이 데모다)
    github_installation_id: 51234567,
    github_installation_login: 'example',
    github_installation_lost_at: null,
    created_at: '2026-03-25T09:00:00Z',
  },
  {
    id: 'demo-bot-2',
    service_name: 'Feedloop 테스트',
    service_url: null,
    service_description: '개발/테스트용',
    status: 'pending',
    pr_mode: 'auto',
    github_repo_url: null,
    widget_connected_at: null,
    last_active_at: '2026-03-27T14:30:00Z',
    channel_connected_at: null,
    display_name: null,
    greeting: null,
    operator_display_name: null,
    knowledge_text: null,
    knowledge_faq: [],
    llm_provider: null,
    llm_model: null,
    hasLlmKey: false,
    llm_key_failed_at: null,
    daily_reply_limit: null,
    github_token_last4: null,
    github_token_failed_at: null,
    github_token_broad: null,
    github_installation_id: null,
    github_installation_login: null,
    github_installation_lost_at: null,
    created_at: '2026-03-27T14:00:00Z',
  },
];

const dateFormatter = new Intl.DateTimeFormat('ko-KR', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const countFormatter = new Intl.NumberFormat('ko-KR');

function formatDate(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : dateFormatter.format(d).replace(/\.\s?/g, '-').replace(/-$/, '');
}

/** https://github.com/owner/repo → owner/repo */
function repoLabel(url: string): string {
  const m = url.match(/github\.com\/([^/]+\/[^/#?]+)/);
  return m ? m[1].replace(/\.git$/, '') : url;
}

function hostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 이름 옆 상태 알약의 공통 틀 — 크기·radius 를 한 곳에서. 색은 잉크·회색·빨강(기존 destructive) 셋뿐 */
const PILL = 'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12.5px] font-semibold leading-[1.45]';

function StatusLabel({ status }: { status: string }) {
  if (status === 'active') {
    // 잉크 채움 — 세그먼트 토글의 「선택됨」과 같은 문법. 이 행에서 코랄은 「연결됨」과 「다음 할 일」 둘만 뜻한다
    return <span className={cn(PILL, 'bg-foreground text-background')}>활성</span>;
  }
  if (status === 'pending') {
    // 회색 테두리 — 채움 없이 «아직» 임을 말한다. 글자는 muted 까지만(faint 는 안 읽힌다)
    return <span className={cn(PILL, 'border border-border-strong text-muted-foreground')}>대기중</span>;
  }
  return <span className={cn(PILL, 'border border-destructive/40 text-destructive')}>오류</span>;
}

/** 「키 확인 필요」 — 누르면 사유가 적힌 API 키 탭으로 바로 간다. */
function KeyCheckBadge({ botId }: { botId: string }) {
  return (
    <Link
      href={`/bots/${botId}/knowledge?tab=key`}
      className={cn(PILL, 'border border-destructive/40 bg-destructive/[0.06] text-destructive hover:bg-destructive/10')}
    >
      키 확인 필요
    </Link>
  );
}

/**
 * 「GitHub … 확인 필요」 — 누르면 사유가 적힌 GitHub 탭으로 바로 간다 (B5 · 앱 설치).
 *
 * 토큰 실패는 빨강(운영자가 새 토큰을 만들어야 한다), 앱 설치 잃어버림은 황색이다 —
 * 후자는 토큰·공용 계정이라는 대안이 아직 남아 있어 같은 무게로 읽히면 안 된다. 둘이 동시에 뜰 수 있다.
 */
function GithubCheckBadge({ botId, label, tone }: { botId: string; label: string; tone: 'token' | 'app' }) {
  return (
    <Link
      href={`/bots/${botId}/knowledge?tab=github`}
      className={cn(
        PILL,
        'border',
        tone === 'token'
          ? 'border-destructive/40 bg-destructive/[0.06] text-destructive hover:bg-destructive/10'
          : 'border-amber-500/50 bg-amber-500/[0.08] text-amber-700 hover:bg-amber-500/15',
      )}
    >
      {label}
    </Link>
  );
}

/** 설치가 살아 있는가. bigint 는 문자열로 올 수 있어 존재 여부만 본다 */
function hasInstallation(bot: BotView): boolean {
  return bot.github_installation_id !== null && bot.github_installation_id !== undefined;
}

/**
 * 「고칠 레포」 칸의 둘째 줄 — 어느 계정으로 PR 을 여는지.
 *
 * 우선순위가 곧 표시 순서다: 앱 설치 → 봇 토큰 → 공용 계정(lib/auto-dev/github-auth.ts).
 * 앱이 연결돼 있으면 토큰이 있어도 PR 을 여는 건 앱이라, 토큰은 「도 있음」 꼬리로만 붙인다 —
 * 둘을 나란히 두면 어느 계정 이름으로 PR 이 열릴지 이 줄만 보고는 알 수 없다.
 */
function GithubConnectionStatus({ bot, isDemo }: { bot: BotView; isDemo: boolean }) {
  const tokenTail = bot.github_token_last4 ? ` · 토큰 ····${bot.github_token_last4} 도 있음` : '';

  // 설치를 잃었으면 그게 먼저다 — 앱 경로가 죽어 있고, 남은 건 토큰이나 공용 계정이다
  if (bot.github_installation_lost_at) {
    return (
      <span className="text-sm">
        <b className="font-semibold text-amber-700">GitHub 앱 확인 필요</b>
        <span className="text-muted-foreground">
          {bot.github_token_last4 && !bot.github_token_failed_at
            ? ` · 토큰 ····${bot.github_token_last4} 로 시도`
            : ' · 공용 계정으로 시도'}
        </span>
      </span>
    );
  }

  if (hasInstallation(bot)) {
    return (
      <span className="text-sm text-muted-foreground">
        Feedloop 앱{bot.github_installation_login ? ` · @${bot.github_installation_login}` : ''}
        {tokenTail}{' '}
        {isDemo ? (
          <span className="whitespace-nowrap font-semibold text-faint">설치 관리 →</span>
        ) : (
          <Link href={`/bots/${bot.id}/knowledge?tab=github`} className="whitespace-nowrap font-semibold hover:underline">
            설치 관리 →
          </Link>
        )}
      </span>
    );
  }

  return <GithubTokenStatus bot={bot} isDemo={isDemo} />;
}

/**
 * 앱 설치가 없을 때의 둘째 줄 (B5).
 * 실패했으면 그게 먼저다. 토큰이 없으면 공용 계정이고, 그건 초대된 레포에서만 되므로 다음 할 일(코랄)이다.
 */
function GithubTokenStatus({ bot, isDemo }: { bot: BotView; isDemo: boolean }) {
  if (bot.github_token_failed_at) {
    return <span className="text-sm font-semibold text-destructive">GitHub 토큰 확인 필요</span>;
  }
  if (bot.github_token_last4) {
    return (
      <span className="text-sm text-muted-foreground">
        내 GitHub 토큰 ····{bot.github_token_last4}
        {bot.github_token_broad && <span className="ml-1.5 text-amber-700">· 계정 전체 권한</span>}
      </span>
    );
  }
  // 문구가 「내 토큰 넣기」에서 「GitHub 연결하기」로 바뀐 이유: 그 탭의 권장 경로가 이제 앱 설치다.
  // 토큰은 대안으로 남아 있고, 링크 하나가 둘 다로 데려간다.
  return (
    <span className="text-sm text-muted-foreground">
      공용 계정으로 시도 · 초대된 저장소만{' '}
      {isDemo ? (
        <span className="whitespace-nowrap font-semibold text-brand-strong/60">GitHub 연결하기 →</span>
      ) : (
        <Link href={`/bots/${bot.id}/knowledge?tab=github`} className="whitespace-nowrap font-semibold text-brand-strong hover:underline">
          GitHub 연결하기 →
        </Link>
      )}
    </span>
  );
}

/**
 * 입구 한 줄 — 채널 이름 14/600 + 연결 상태 알약. v2 의 15px 는 크기 단계를 하나 더 만들었다 —
 * 상태 열의 무게는 크기가 아니라 굵기로 준다. 「연결됨」은 코랄 옅은 채움, 「미연결」은 회색 테두리.
 */
function Channel({ icon, label, on }: { icon: React.ReactNode; label: string; on: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
      <span className="text-muted-foreground">{icon}</span>
      {label}
      {on ? (
        <span className={cn(PILL, 'bg-brand-subtle text-brand-strong')}>
          <i className="block h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
          연결됨
        </span>
      ) : (
        <span className={cn(PILL, 'border border-border text-muted-foreground')}>미연결</span>
      )}
    </span>
  );
}

/**
 * 칸이 비어 있을 때 「다음 할 일」을 말하는 한 줄.
 * 회색이 아니라 잉크다 — 「없음」이 「있음」보다 가벼워 보이면 막힌 곳이 안 보인다.
 */
function Hint({ children }: { children: React.ReactNode }) {
  return <span className="text-sm leading-snug text-foreground">{children}</span>;
}

/**
 * 칸의 행동 링크. 칸마다 하나만 둔다 — 상태를 바꾸는 화면으로 간다.
 *
 * 색이 곧 우선순위다. `next` 면 코랄(비어 있어서 다음에 할 일), 아니면 잉크(이미 있는 걸 바꾸는 일).
 * 링크 넷이 다 코랄이면 아무것도 두드러지지 않는다.
 * 데모 모드는 같은 자리에 같은 문구를 두되 눌리지 않는다(구조가 어떻게 생겼는지는 보이게).
 */
function CellAction({
  href,
  next,
  disabled,
  children,
}: {
  href: string;
  next?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  // 문구와 화살표가 한 덩어리 — 좁은 칸에서 화살표만 다음 줄로 떨어지지 않게
  const label = <span className="whitespace-nowrap">{children} →</span>;
  if (disabled) {
    // 데모(비로그인)에서도 「다음 할 일」의 색은 남긴다 — 심사 중 기본 상태가 데모다
    return (
      <span className={cn('mt-auto pt-2 text-sm font-semibold', next ? 'text-brand-strong/60' : 'text-faint')}>
        {label}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className={cn(
        'mt-auto pt-2 text-sm font-semibold hover:underline',
        next ? 'text-brand-strong' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </Link>
  );
}

/** 설정 줄의 링크 하나 — 잉크. 「다음 할 일」 강조는 위 칸의 코랄 링크가 이미 하고 있다 */
function SettingsLink({ href, disabled, children }: { href: string; disabled?: boolean; children: React.ReactNode }) {
  if (disabled) return <span className="font-semibold text-faint">{children}</span>;
  return (
    <Link href={href} className="font-semibold text-muted-foreground hover:text-foreground hover:underline">
      {children}
    </Link>
  );
}

/**
 * A bot the viewer only approves for (stage 3, 6/6). Name, status, where feedback comes in, and the one
 * place they can act: the inbox. No settings links, no delete, nothing the owner configures.
 */
function ApproverRow({ bot }: { bot: ApproverBotView }) {
  const webOn = Boolean(bot.widget_connected_at);
  const channelOn = Boolean(bot.channel_connected_at);
  return (
    <li id={`bot-${bot.id}`} className="card-surface flex scroll-mt-20 flex-col gap-4 p-5 sm:p-6">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <h2 className="break-words text-xl font-bold leading-[1.2] tracking-[-0.02em]">{bot.service_name}</h2>
          <StatusLabel status={bot.status} />
          <span className={cn(PILL, 'bg-muted text-muted-foreground')}>Approver</span>
        </div>
        <p className="mt-1.5 truncate text-[12.5px] leading-[1.45] text-muted-foreground">
          {bot.service_url ? hostLabel(bot.service_url) : bot.service_description || '서비스 주소 없음'}
          <span className="mx-1.5">·</span>
          등록 {formatDate(bot.created_at)}
        </p>
      </div>
      <div className="grid gap-x-8 gap-y-5 lg:grid-cols-[300px_minmax(0,1fr)]">
        <Cell title="입구">
          <div className="flex flex-col gap-1.5">
            <Channel icon={<RiChat1Line className="h-4 w-4" aria-hidden />} label={sourceLabel('web')} on={webOn} />
            <Channel icon={<RiCustomerService2Line className="h-4 w-4" aria-hidden />} label={sourceLabel('channel')} on={channelOn} />
          </div>
        </Cell>
        <Cell
          title="내 역할"
          action={
            <CellAction href="/inbox" next>
              받은편지함 열기
            </CellAction>
          }
        >
          <span className="text-sm text-muted-foreground">
            You approve or reject this bot&apos;s refund requests in the inbox. Replies, settings and the API key stay
            with the owner.
          </span>
        </Cell>
      </div>
    </li>
  );
}

function Cell({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 border-t border-border pt-3.5">
      <span className="text-[12.5px] font-semibold leading-[1.45] text-muted-foreground">{title}</span>
      {children}
      {action}
    </div>
  );
}

/** 「API 키」 한 줄 — 누구 돈으로 답하는지. 실패했으면 그게 먼저다 */
function LlmKeyStatus({ bot }: { bot: BotView }) {
  if (bot.llm_key_failed_at) {
    return <span className="text-sm font-semibold text-destructive">API 키 확인 필요</span>;
  }
  // 아래 순서는 `resolveLimit` 과 «같다» — daily_reply_limit 예외가 걸린 봇은 provider·키
  // 유무와 무관하게 그 값이 이긴다. 키 분기를 먼저 보면 예외 적용 봇이 키 문구에 걸려
  // 상한을 영영 말하지 못한다.
  const key =
    bot.hasLlmKey && isLlmProvider(bot.llm_provider)
      ? `내 키 · ${PROVIDER_LABELS[bot.llm_provider]} ${effectiveModelId(bot.llm_provider, bot.llm_model)}`
      : null;

  if (bot.daily_reply_limit != null) {
    // 예외가 상한을 정하지만 「누구 돈으로」는 여전히 키가 정한다 — 둘 다 사실이라 함께 둔다.
    return (
      <span className="truncate text-sm text-muted-foreground">
        하루 {countFormatter.format(bot.daily_reply_limit)}건 · 예외 적용{key ? ` · ${key}` : ''}
      </span>
    );
  }
  if (key) {
    return <span className="truncate text-sm text-muted-foreground">{key}</span>;
  }
  return (
    <span className="text-sm text-muted-foreground">
      무료 {DEFAULT_LIMITS.noKey}건/일 · {PLATFORM_MODEL_LABEL}
    </span>
  );
}

export default async function BotsPage({ searchParams }: { searchParams: Promise<{ app?: string | string[] }> }) {
  // 설치 콜백이 «어느 봇인지 못 정한 채» 돌아오면 여기로 온다. 이 값을 안 읽으면 운영자는 아무 안내도 못 받는다(코드 리뷰 HIGH)
  const { app } = await searchParams;
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id ?? null;
  const isDemo = !userId;

  // 사용자 소유의 봇(설정 전부) + 승인자로 참여한 봇(bot_members — PayPal 해커톤 데모 봇; 축소 뷰)
  let bots: BotView[] = demoBots;
  // bots this user only approves for: read with the short column list, drawn as a compact row with no
  // settings — knowledge, key tail, GitHub and the owner's id never leave the database for them (6/6)
  let approverBots: ApproverBotView[] = [];
  // a demo bot exists on this deployment and this user is not in it yet → offer "Try the demo bot"
  let canJoinDemo = false;
  if (userId) {
    const supabase = getServiceRoleClient();
    let access = { owned: [] as string[], approver: [] as string[] };
    try {
      access = await listAccessibleBots(userId);
    } catch (e) {
      console.error('Error listing accessible bots:', e instanceof Error ? e.message : e);
    }
    bots = [];
    if (access.owned.length > 0) {
      const { data, error } = await supabase
        .from('bots')
        .select(BOT_COLUMNS)
        .in('id', access.owned)
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error fetching bots:', error);
      }
      bots = ((data ?? []) as unknown as BotRow[]).map(toView);
    }
    if (access.approver.length > 0) {
      const { data, error } = await supabase
        .from('bots')
        .select(APPROVER_BOT_COLUMNS)
        .in('id', access.approver)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error fetching approver bots:', error);
      }
      approverBots = ((data ?? []) as unknown as Record<string, unknown>[]).map(toApproverView);
    }
    const { data: demoRow } = await supabase.from('bots').select('id').eq('is_demo', true).maybeSingle();
    canJoinDemo = Boolean(demoRow && !access.owned.includes(demoRow.id) && !access.approver.includes(demoRow.id));
  }

  // 위젯 스니펫의 주소 — 연결 화면(/bots/[id]/connect)과 같은 방식으로 만든다.
  const h = await headers();
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const baseUrl = process.env.WEBHOOK_BASE_URL || `${proto}://${h.get('host')}`;

  // 히어로 부제는 숫자·사실 한 줄. 「들어오는 중」 = 입구가 하나라도 살아 있는 서비스(아래 행의 anyOn 과 같은 판정)
  const isReceiving = (b: { widget_connected_at: string | null; channel_connected_at: string | null; last_active_at: string | null }) =>
    Boolean(b.widget_connected_at) || Boolean(b.channel_connected_at) || Boolean(b.last_active_at);
  const receivingCount = bots.filter(isReceiving).length + approverBots.filter(isReceiving).length;
  const totalCount = bots.length + approverBots.length;

  const registerButton = isDemo ? (
    <Button disabled>새 서비스 등록</Button>
  ) : (
    <Button asChild>
      <Link href="/bots/new">새 서비스 등록</Link>
    </Button>
  );
  const heroActions = (
    <div className="flex flex-wrap items-center gap-2">
      {canJoinDemo && <TryDemoBotButton />}
      {registerButton}
    </div>
  );

  return (
    <div className="flex flex-col gap-10">
      <InstallResultBanner app={app} />
      <PageHero
        emoji={PAGE_EMOJI.bots}
        title="챗봇 설정"
        description={<ScopedBotsSummary total={totalCount} receiving={receivingCount} />}
        actions={heroActions}
      />

      {totalCount === 0 ? (
        // 빈 상태 — 실패가 아니라 시작점이다. 이모지 하나 + 한 줄 + 다음 할 일(코랄 버튼)
        <div className="card-surface flex flex-col items-center gap-4 px-6 py-14 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/emoji/rocket_3d.png" alt="" aria-hidden width={56} height={56} className="h-14 w-14" />
          <p className="text-sm leading-relaxed text-muted-foreground">
            서비스를 등록하고 스크립트 한 줄을 붙이면 피드백이 들어오기 시작해요
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button asChild>
              <Link href="/bots/new">서비스 등록하기</Link>
            </Button>
            {canJoinDemo && <TryDemoBotButton />}
          </div>
        </div>
      ) : (
        <ul className="flex flex-col gap-5">
          {bots.map((bot) => {
            const webOn = Boolean(bot.widget_connected_at);
            const channelOn = Boolean(bot.channel_connected_at);
            // 카카오는 입구 목록에서 내렸지만 웹훅 라우트는 살아 있다. 이 값에서까지 빼면
            // 카카오로만 들어오는 봇이 「아직 들어올 길이 없어요」라는 틀린 말을 듣는다.
            // 권유는 아래 <Channel> 줄과 코랄 CTA 가 하는 일이고, 이건 사실 판정이다.
            const kakaoOn = Boolean(bot.last_active_at);
            // 입구가 «하나라도» 살아 있으면 「다음 할 일」이 아니다 — 채널톡만 붙인 봇이
            // 코랄 링크와 「아직 들어올 길이 없어요」를 동시에 띄우면 안 된다
            const anyOn = webOn || channelOn || kakaoOn;
            const displayName = bot.display_name || bot.service_name;
            const knowledgeChars = knowledgeSize(bot.knowledge_text, bot.knowledge_faq);
            const faqCount = bot.knowledge_faq.filter((f) => f && f.q?.trim() && f.a?.trim()).length;
            const knowledgeEmpty = knowledgeChars === 0;
            const knowledgeHref = bot.llm_key_failed_at
              ? `/bots/${bot.id}/knowledge?tab=key`
              : `/bots/${bot.id}/knowledge`;
            return (
              <ScopedBotRow key={bot.id} botId={bot.id}>
                <li
                  // 헤더 셀렉터의 「이 서비스 설정」 지름길이 `#bot-<id>` 로 이 행에 내려온다(I-27)
                  id={`bot-${bot.id}`}
                  className="card-surface grid scroll-mt-20 gap-x-8 gap-y-5 p-5 sm:p-6 lg:grid-cols-[300px_minmax(0,1fr)]"
                >
                  {/* 이름 줄 — 행 전체 폭. 아래 칸 넷의 헤어라인이 같은 높이에서 시작하게 한 줄로 뺀다 */}
                  <div className="min-w-0 lg:col-span-2">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                      <h2 className="break-words text-xl font-bold leading-[1.2] tracking-[-0.02em]">
                        {bot.service_name}
                      </h2>
                      <StatusLabel status={bot.status} />
                      {/* 키·모델이 잘못돼도 피드백은 저장된다. 잃는 건 자동 답변뿐이라 운영자가 «여기서»
                          알아채지 못하면 조용히 답이 안 나가는 상태가 이어진다 — 이름 옆에 한 번 더 띄운다 */}
                      {bot.llm_key_failed_at && !isDemo && <KeyCheckBadge botId={bot.id} />}
                      {bot.github_token_failed_at && !isDemo && (
                        <GithubCheckBadge botId={bot.id} label="GitHub 토큰 확인 필요" tone="token" />
                      )}
                      {bot.github_installation_lost_at && !isDemo && (
                        <GithubCheckBadge botId={bot.id} label="GitHub 앱 확인 필요" tone="app" />
                      )}
                    </div>
                    <p className="mt-1.5 truncate text-[12.5px] leading-[1.45] text-muted-foreground">
                      {bot.service_url ? hostLabel(bot.service_url) : bot.service_description || '서비스 주소 없음'}
                      <span className="mx-1.5">·</span>
                      등록 {formatDate(bot.created_at)}
                    </p>
                  </div>

                  {/* 입구 — 어디서 피드백이 들어오는지. 왼쪽 300 에 15px 로 두어 ① 을 먼저 읽게 한다.
                      링크는 스크립트 발급·오픈빌더 안내 화면 */}
                  <Cell
                    title="입구"
                    action={
                      <CellAction href={`/bots/${bot.id}/connect`} next={!anyOn} disabled={isDemo}>
                        연결 설정하기
                      </CellAction>
                    }
                  >
                    {/* 권유하는 입구 둘만 보인다. 카카오톡은 2026-09-14 에 화면에서 내렸다 —
                        웹훅·대기열은 살아 있고 「대화」의 입구 라벨에도 그대로 뜨지만, 여기서 물으면
                        붙이라는 말이 된다. 라벨은 공용 맵(lib/channel/labels.ts).
                        순서는 연결 화면 갈림길과 같다 */}
                    <div className="flex flex-col gap-1.5">
                      <Channel icon={<RiChat1Line className="h-4 w-4" aria-hidden />} label={sourceLabel('web')} on={webOn} />
                      <Channel
                        icon={<RiCustomerService2Line className="h-4 w-4" aria-hidden />}
                        label={sourceLabel('channel')}
                        on={channelOn}
                      />
                    </div>
                    {!anyOn && <Hint>아직 들어올 길이 없어요. 스크립트 한 줄을 붙이면 됩니다</Hint>}
                  </Cell>

                  {/* 나머지 3칸 — 한 번 정하면 잘 안 바뀌는 것(레포·모양)과 답변의 근거(지식·키) */}
                  <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 md:grid-cols-3">
                    {/* 고칠 레포 — 이 칸의 행동은 PR 모드 토글이라 링크가 따로 없다.
                        레포 URL 은 등록 뒤 고치는 화면이 아직 없다(제품 공백) — 그래서 「없음」 안내만 하고 코랄 링크를 만들지 않는다 */}
                    <Cell title="고칠 저장소">
                      {bot.github_repo_url ? (
                        <a
                          href={bot.github_repo_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="truncate text-sm font-medium hover:underline"
                        >
                          {repoLabel(bot.github_repo_url)}
                        </a>
                      ) : (
                        <Hint>저장소가 없어 수정안을 만들지 않아요. 피드백 분류까지만 합니다</Hint>
                      )}
                      {/* 어느 GitHub 계정으로 PR 을 여는지 (앱 설치 → 봇 토큰 → 공용). 레포가 있을 때만 뜻이 있다 */}
                      {bot.github_repo_url && <GithubConnectionStatus bot={bot} isDemo={isDemo} />}
                      {/* 등록 때 고른 PR 모드를 여기서 바꾼다. 자동 모드는 /api/cron/auto-pr 이 매일 돈다. */}
                      <PrModeControl
                        botId={bot.id}
                        initial={(bot.pr_mode as PrMode) ?? 'approve'}
                        disabled={isDemo || !bot.github_repo_url}
                      />
                    </Cell>

                    {/* 위젯 모양 — 방문자 눈에 보이는 이름·인사말. 링크는 편집 화면 */}
                    <Cell
                      title="위젯 모양"
                      action={
                        <CellAction href={`/bots/${bot.id}/appearance`} disabled={isDemo}>
                          모양 바꾸기
                        </CellAction>
                      }
                    >
                      <span className="truncate text-sm">
                        <b className="font-semibold">{displayName}</b>
                        <span className="text-muted-foreground">
                          {' '}
                          · 답장 {bot.operator_display_name || defaultOperatorName(displayName)}
                        </span>
                      </span>
                      <span className="line-clamp-2 text-sm text-muted-foreground">
                        {bot.greeting ? `“${bot.greeting}”` : `기본 인사말 “${defaultGreeting(displayName)}”`}
                      </span>
                    </Cell>

                    {/* 답변 지식 — 봇이 무엇을 근거로(지식), 누구 돈으로(API 키) 답하는지. 링크는 지식·키 화면 */}
                    <Cell
                      title="답변 지식"
                      action={
                        <CellAction
                          href={knowledgeHref}
                          next={knowledgeEmpty || Boolean(bot.llm_key_failed_at)}
                          disabled={isDemo}
                        >
                          {bot.llm_key_failed_at ? '키 확인하기' : knowledgeEmpty ? '지식 넣기' : '지식·키 설정'}
                        </CellAction>
                      }
                    >
                      {knowledgeEmpty ? (
                        <Hint>아직 지식이 없어요. 넣으면 근거를 갖고 답합니다</Hint>
                      ) : (
                        // 이 칸만 큰 숫자 — 지식의 양이 곧 답변의 근거이자 호출 1건의 비용이다
                        <span className="flex items-baseline gap-2">
                          <span className="text-[20px] font-extrabold leading-none tracking-[-0.02em] tabular-nums">
                            {countFormatter.format(knowledgeChars)}
                            <span className="ml-0.5 text-sm font-semibold tracking-normal text-muted-foreground">자</span>
                          </span>
                          <span className="text-[12.5px] text-muted-foreground">
                            FAQ <span className="tabular-nums">{faqCount}</span>개
                          </span>
                        </span>
                      )}
                      <LlmKeyStatus bot={bot} />
                    </Cell>
                  </div>

                  {/* 설정 묶음 + 삭제(I-18·I-25). 위 칸들의 링크는 «그 칸의 상태를 바꾸는» 자리이고,
                      이 줄은 «이 서비스에 대해 할 수 있는 일 전부»를 한 곳에서 훑는 자리다.
                      삭제는 이 줄에만 있다 — 칸 안에 두면 「지식 넣기」 옆에서 눌릴 자리가 된다 */}
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5 border-t border-border pt-4 text-sm lg:col-span-2">
                    <span className="text-[12.5px] font-semibold text-muted-foreground">설정</span>
                    <SettingsLink href={`/bots/${bot.id}/connect`} disabled={isDemo}>연결</SettingsLink>
                    <SettingsLink href={`/bots/${bot.id}/appearance`} disabled={isDemo}>위젯 모양</SettingsLink>
                    <SettingsLink href={`/bots/${bot.id}/knowledge`} disabled={isDemo}>답변 지식</SettingsLink>
                    <SettingsLink href={`/bots/${bot.id}/knowledge?tab=key`} disabled={isDemo}>API 키</SettingsLink>
                    <SettingsLink href={`/bots/${bot.id}/knowledge?tab=github`} disabled={isDemo}>GitHub 연결</SettingsLink>
                    <div className="ml-auto flex min-w-0 basis-full justify-end sm:basis-auto">
                      <DeleteBotButton botId={bot.id} serviceName={bot.service_name} disabled={isDemo} />
                    </div>
                  </div>
                </li>
              </ScopedBotRow>
            );
          })}
          {approverBots.map((bot) => (
            <ScopedBotRow key={bot.id} botId={bot.id}>
              <ApproverRow bot={bot} />
            </ScopedBotRow>
          ))}
        </ul>
      )}

      {/* 카드가 아니다 — 목록이 아니라 한 줄 코드라, 바탕 위에 제목·코드·각주로만 둔다.
          어느 서비스의 스크립트인지는 헤더 선택을 따라간다(ScopedWidgetSnippet 주석).
          승인자 봇은 제외 — 남의 사이트에 붙일 스크립트를 발급받을 이유가 없다. */}
      <ScopedWidgetSnippet
        bots={bots.map((b) => ({ id: b.id, service_name: b.service_name }))}
        baseUrl={baseUrl}
        isDemo={isDemo}
      />
    </div>
  );
}
