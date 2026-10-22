'use client';

// 헤더의 서비스 셀렉터(I-27). 봇이 둘 이상일 때만 나타난다 — 하나뿐이면 고를 것이 없다.
//
// 화면에 따라 두 가지 일을 한다.
//  1) 대시보드·대화·피드백·수정안 — 「보는 범위」. 「전체 서비스」가 기본이고 선택은 브라우저에 남는다.
//  2) `/bots/<id>/…`(연결·답변 지식·위젯 모양) — 「지금 설정 중인 서비스」. 이 화면들은 주소에 봇이
//     박혀 있어 저장된 범위를 고쳐도 내용이 그대로였다. 고르면 같은 하위 화면의 그 봇으로 «옮긴다».
//     여기서는 「전체 서비스」가 뜻을 갖지 않으므로 목록에서 뺀다(목록으로 가는 길은 화면 안에 있다).

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { usePathname } from '@/i18n/navigation';
import { Settings2 } from 'lucide-react';
import { useBotScope } from '@/lib/scope/BotScopeProvider';
import { ScopeDropdown } from '@/components/layout/ScopeDropdown';
import { carryQuery, routeBotSegment, swapRouteBot, SCOPE_MIN_BOTS } from '@/lib/scope/scope';

export function BotScopeSelect() {
  const t = useTranslations('nav.scope');
  const { bots, botId, setBotId, loaded } = useBotScope();
  const pathname = usePathname();
  const router = useRouter();

  // 목록을 읽기 전에는 판정하지 않는다 — `routeBotSegment` 가 봇 목록으로 `/bots/new` 를 걸러낸다.
  const route = loaded ? routeBotSegment(pathname, bots) : null;
  if (!loaded || bots.length < SCOPE_MIN_BOTS) return null;

  // 주소가 봇을 가리키면 그 봇을 보여준다 — 저장된 범위와 달라도 «화면이 말하는 것»이 우선이다.
  const selected = route ? route.botId : botId;

  const onPick = (next: string) => {
    if (route) {
      // 설정 화면 이동 — 전역 범위는 건드리지 않는다. 다른 탭으로 갔을 때 몰래 바뀌어 있으면 안 된다.
      // 쿼리는 `carryQuery` 가 화면별로 가린다 — 연결 화면의 `via`·`tab` 은 연결 상태에 딸린 값이라 두고 간다.
      router.push(swapRouteBot(route.sub, next, carryQuery(route.sub, window.location.search)));
      return;
    }
    setBotId(next || null);
  };

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <ScopeDropdown
        label={route ? t('configuring') : t('viewing')}
        value={selected ?? ''}
        onPick={onPick}
        options={[
          // 설정 화면에서는 「전체 서비스」가 뜻을 갖지 않는다(맨 위 주석 2).
          ...(route ? [] : [{ value: '', label: t('all') }]),
          ...bots.map((b) => ({ value: b.id, label: b.service_name })),
        ]}
        className="min-w-0"
      />
      {selected && !route && (
        // 고른 서비스의 설정으로 가는 지름길 하나 — 「챗봇 설정」 목록에서 그 행으로 내려간다.
        // 이미 그 서비스의 설정 화면에 있을 때는(route) 자기 자신을 가리키므로 그리지 않는다.
        <Link
          href={`/bots#bot-${selected}`}
          aria-label={t('settings')}
          title={t('settings')}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Settings2 className="h-4 w-4" aria-hidden />
        </Link>
      )}
    </div>
  );
}

/**
 * 히어로 부제 앞에 붙는 한 조각 — 「지금 널널투어만 보는 중 · 」. 전체면 아무것도 안 그린다.
 * 셀렉터가 헤더에 있어 화면 본문만 보면 어느 서비스 기준인지 놓치기 쉽다.
 */
export function ScopeNote() {
  const t = useTranslations('nav.scope');
  const { current } = useBotScope();
  if (!current) return null;
  return (
    <>
      {t.rich('only', {
        name: current.service_name,
        b: (chunks) => <b className="font-semibold text-foreground">{chunks}</b>,
      })}
    </>
  );
}
