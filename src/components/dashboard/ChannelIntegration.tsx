import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { RiChat1Line, RiCustomerService2Line } from 'react-icons/ri';
import { cn } from '@/lib/utils';

// 최종 채널은 웹 위젯(권장) + 채널톡(선택) 둘이다.
// Discord·텔레그램은 만든 적 없는 연동이라 목록에 두지 않는다.
// 카카오톡은 2026-09-14 에 화면에서 내렸다 — 웹훅·대기열 코드는 살아 있지만 라이브 연결이
// 없고(마지막 메시지 2026-09-06), 권유할 입구가 아니다.
// 순서는 연결 화면 갈림길과 같게 둔다 — 두 화면이 다른 순서를 말하면 어느 쪽이 권유인지 흐려진다.
const channels = [
  { id: 'web', icon: RiChat1Line, iconClass: 'bg-muted text-foreground' },
  { id: 'channel', icon: RiCustomerService2Line, iconClass: 'bg-muted text-foreground' },
] as const;

export interface ChannelIntegrationProps {
  /** 어느 봇이든 웹 위젯이 첫 메시지를 받았는가(`widget_connected_at`). 판정 정본은 /bots 와 같다 */
  webOn: boolean;
  /** 어느 봇이든 채널톡 웹훅이 연결됐는가(`channel_connected_at`) */
  channelOn: boolean;
}

/**
 * 사이드 칼럼 「피드백 채널」 — 아이콘 34 + 이름 14/600 + 연결 상태.
 * 상태는 부모가 `/api/bots` 로 읽어 내려준다 — 여기서 정적으로 「연결됨」을 그리면
 * 아무것도 안 붙인 새 계정이 첫 화면에서 거짓말을 본다(I-35).
 * 봇이 여럿이면 합산이다(하나라도 켜져 있으면 「연결됨」). 봇별 분리는 I-27 의 몫.
 */
export function ChannelIntegration({ webOn, channelOn }: ChannelIntegrationProps) {
  const t = useTranslations('dashboard.channels');
  const on: Record<string, boolean> = { web: webOn, channel: channelOn };
  return (
    <section className="card-surface flex flex-col gap-2 p-5">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-bold">{t('title')}</h3>
        <Link href="/bots" className="text-[12.5px] font-semibold text-brand-strong">
          {t('settings')}
        </Link>
      </div>
      <ul>
        {channels.map((ch) => (
          <li key={ch.id} className="flex items-center gap-3 border-t border-border py-3 first:border-t-0">
            <span className={cn('inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px]', ch.iconClass)}>
              <ch.icon className="h-[18px] w-[18px]" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{t(ch.id)}</p>
              <p className="truncate text-[12.5px] text-muted-foreground">{t(`${ch.id}Sub`)}</p>
            </div>
            {on[ch.id] ? (
              <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-brand-strong">
                <i className="block h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
                {t('on')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                <i className="block h-1.5 w-1.5 rounded-full bg-border" aria-hidden />
                {t('off')}
                <Link href="/bots" className="font-semibold text-brand-strong">
                  {t('connect')}
                </Link>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
