'use client';

// 입구 「연결 해제」(I-25) — 위젯·채널톡 각각. 두 단계(누름 → 그 자리에서 확인)다.
//
// 두 해제는 뜻이 다르다. 위젯은 «표시»만 내린다(스크립트가 남아 있으면 다음 방문자가 열 때 다시
// 켜진다). 채널톡은 키·웹훅 주소를 지우고 그 경로로 들어온 대화의 실명·연락처를 익명화한다
// (U6). 문구가 그 차이를 그대로 말해야 운영자가 「지워졌다」와 「내려갔다」를 헷갈리지 않는다.

import { useReducer } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

interface DisconnectButtonProps {
  botId: string;
  kind: 'widget' | 'channel';
}

interface DisconnectState {
  open: boolean;
  busy: boolean;
  error: string | null;
}

type DisconnectAction = { type: 'open' } | { type: 'cancel' } | { type: 'submit' } | { type: 'fail'; error: string };

const INITIAL: DisconnectState = { open: false, busy: false, error: null };

function reducer(state: DisconnectState, action: DisconnectAction): DisconnectState {
  switch (action.type) {
    case 'open':
      return { open: true, busy: false, error: null };
    case 'cancel':
      return INITIAL;
    case 'submit':
      return { ...state, busy: true, error: null };
    case 'fail':
      return { ...state, busy: false, error: action.error };
  }
}

const PATHS = { widget: 'widget', channel: 'channel' } as const;

export function DisconnectButton({ botId, kind }: DisconnectButtonProps) {
  const router = useRouter();
  const t = useTranslations('connect.disconnect');
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const copy = { path: PATHS[kind], title: t(`${kind}.title`), body: t(`${kind}.body`), confirm: t(`${kind}.confirm`) };

  async function handleDisconnect() {
    if (state.busy) return;
    dispatch({ type: 'submit' });
    try {
      const res = await fetch(`/api/bots/${botId}/${copy.path}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? t('error'));
      }
      // 서버 컴포넌트(현황판)가 새 상태를 다시 그린다 — 둘 다 꺼졌으면 갈림길로 돌아간다.
      router.refresh();
    } catch (err) {
      dispatch({ type: 'fail', error: err instanceof Error ? err.message : t('error') });
    }
  }

  if (!state.open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => dispatch({ type: 'open' })} className="text-destructive hover:text-destructive">
        {t('button')}
      </Button>
    );
  }

  return (
    <div role="group" aria-label={copy.title} className="flex w-full flex-col gap-2.5 rounded-[10px] border border-destructive/40 p-3.5">
      <p className="text-sm font-semibold">{copy.title}</p>
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">{copy.body}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="destructive" size="sm" onClick={handleDisconnect} disabled={state.busy}>
          {state.busy ? t('busy') : copy.confirm}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => dispatch({ type: 'cancel' })} disabled={state.busy}>
          {t('cancel')}
        </Button>
      </div>
      {state.error && (
        <p role="alert" className="text-[12.5px] text-destructive">
          {state.error}
        </p>
      )}
    </div>
  );
}
