'use client';

// 「챗봇 설정」 목록을 헤더 셀렉터(I-27)에 맞춘다.
//
// 이 화면만 선택을 안 따르고 서비스를 전부 뿌렸다. 빠뜨린 게 아니라 «구조» 때문이다 —
// 네 화면(대시보드·대화·피드백·수정안)은 브라우저에서 그려 `useBotScope` 를 읽을 수 있지만
// 이 페이지는 서버에서 그려서 localStorage 에 손이 닿지 않는다. 그래서 서버는 전부 그리고,
// 여기서 «보여줄 것만» 고른다. 페이지를 클라이언트로 통째로 옮기지 않는 이유는 그렇게 하면
// 목록 조회가 왕복 하나를 더 타고, 서버가 쥔 값(baseUrl·설치 결과 배너)까지 따라 옮겨야 해서다.
//
// ⚠️ 서버가 그린 행은 숨겨도 «만들어지긴» 한다. 남의 서비스가 아니라 내 서비스들이므로
//    새는 정보는 없다. 대신 행 자체를 DOM 에서 빼서(null 반환) 스크린리더와 Ctrl+F 가
//    안 보이는 행을 읽지 않게 한다.

import { useTranslations } from 'next-intl';
import { useBotScope } from '@/lib/scope/BotScopeProvider';
import { SectionTitle } from '@/components/layout/SectionTitle';
import { CopySnippetButton } from '@/components/bots/CopySnippetButton';

/**
 * 고른 서비스가 «실재하는지» 확인한 뒤에만 거른다.
 *
 * 목록을 아직 안 읽었으면(`loaded === false`) 저장된 선택을 믿는다 — 여기서 의심하면
 * 첫 그림에 전부 떴다가 하나로 줄어드는 깜빡임이 난다. 읽고 나서 없는 id 로 드러나면
 * 거르기를 풀어 «아무것도 없는 화면»을 면한다(지운 서비스가 선택에 남아 있던 경우).
 */
function useScopeFilter(): (botId: string) => boolean {
  const { botId: selected, bots, loaded } = useBotScope();
  return (botId: string) => {
    if (!selected) return true;
    if (loaded && !bots.some((b) => b.id === selected)) return true;
    return selected === botId;
  };
}

export function ScopedBotRow({ botId, children }: { botId: string; children: React.ReactNode }) {
  const visible = useScopeFilter()(botId);
  if (!visible) return null;
  return <>{children}</>;
}

/**
 * 히어로 부제. 전체일 때는 예전과 같은 숫자 한 줄이고, 하나만 볼 때는 **무엇을 보고 있는지**와
 * 전체가 몇인지를 같이 말한다 — 「3개」만 떠 있는데 한 개만 보이면 화면이 고장 난 것처럼 읽힌다.
 *
 * 「…만 보는 중」은 다른 네 화면의 `ScopeNote` 와 같은 문법이다.
 */
export function ScopedBotsSummary({
  total,
  receiving,
}: {
  total: number;
  receiving: number;
}) {
  const t = useTranslations('bots.scoped');
  const { botId: selected, current, bots, loaded } = useBotScope();
  const filtering = Boolean(selected) && (!loaded || bots.some((b) => b.id === selected));

  if (total === 0) return <>{t('zero')}</>;

  if (filtering && current) {
    return <>{t.rich('only', { name: current.service_name, total, b: (c) => <b className="font-semibold text-foreground">{c}</b>, strong: (c) => <strong className="tabular-nums">{c}</strong> })}</>;
  }

  return <>{t.rich('summary', { total, receiving, strong: (c) => <strong className="tabular-nums">{c}</strong> })}</>;
}

/**
 * 위젯 스크립트 한 줄. **보고 있는 서비스의 것**을 준다.
 *
 * 서버는 늘 `bots[0]` 으로 만들었다. 전부 보일 때는 「첫 번째 것」이 덜 어색했지만, 하나만
 * 남기고 나니 「Feedloop 을 보는 중인데 다오마켓 스크립트를 복사시키는」 화면이 됐다
 * (2026-09-20 화면 확인). 복사해서 붙이는 값이라 틀리면 조용히 남의 봇으로 연결된다.
 */
export function ScopedWidgetSnippet({
  bots,
  baseUrl,
  isDemo,
}: {
  bots: { id: string; service_name: string }[];
  baseUrl: string;
  isDemo: boolean;
}) {
  const t = useTranslations('bots.scoped');
  const { botId: selected, bots: scopeBots, loaded } = useBotScope();
  const filtering = Boolean(selected) && (!loaded || scopeBots.some((b) => b.id === selected));
  const target = (filtering ? bots.find((b) => b.id === selected) : undefined) ?? bots[0];
  if (!target) return null;

  const snippet = `<script src="${baseUrl}/widget.js" data-feedloop="${target.id}" async></script>`;
  // 하나만 보는 중이면 「다른 서비스는 각 행에서」가 가리킬 행이 화면에 없다 — 그 말을 뺀다.
  const sub =
    !filtering && bots.length > 1
      ? t('subOnly', { name: target.service_name })
      : t('subAll', { name: target.service_name, body: '<body>' });

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <SectionTitle sub={sub}>{t('snippetTitle')}</SectionTitle>
        {!isDemo && <CopySnippetButton text={snippet} />}
      </div>
      <code className="block overflow-x-auto whitespace-nowrap rounded-2xl border border-border bg-card px-5 py-4 font-mono text-[12.5px] leading-relaxed text-foreground">
        {snippet}
      </code>
      <p className="text-[12.5px] leading-[1.45] text-muted-foreground">
        {t('snippetNote')}
      </p>
    </section>
  );
}
