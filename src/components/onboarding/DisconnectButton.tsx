'use client';

// 입구 「연결 해제」(I-25) — 위젯·채널톡 각각. 두 단계(누름 → 그 자리에서 확인)다.
//
// 두 해제는 뜻이 다르다. 위젯은 «표시»만 내린다(스크립트가 남아 있으면 다음 방문자가 열 때 다시
// 켜진다). 채널톡은 키·웹훅 주소를 지우고 그 경로로 들어온 대화의 실명·연락처를 익명화한다
// (U6). 문구가 그 차이를 그대로 말해야 운영자가 「지워졌다」와 「내려갔다」를 헷갈리지 않는다.

import { useReducer } from 'react';
import { useRouter } from 'next/navigation';
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

const COPY = {
  widget: {
    path: 'widget',
    title: '위젯 연결 표시를 내릴까요?',
    body:
      '「연결됨」 표시만 지웁니다. 서비스에 스크립트가 남아 있으면 다음 방문자가 위젯을 열 때 다시 「연결됨」이 돼요 — 채널톡으로 옮기실 거면 서비스에서 스크립트를 먼저 지우고 내려 주세요. 대화·피드백은 그대로입니다.',
    confirm: '표시 내리기',
  },
  channel: {
    path: 'channel',
    title: '채널톡 연결을 끊을까요?',
    body:
      '저장된 키와 웹훅 주소가 지워져 채널톡에서 더 이상 들어오지 않아요. 채널톡으로 들어온 대화의 이름·연락처는 익명화되고 본문은 남습니다. 채널톡 쪽 웹훅 등록은 직접 지워 주세요.',
    confirm: '연결 끊기',
  },
} as const;

export function DisconnectButton({ botId, kind }: DisconnectButtonProps) {
  const router = useRouter();
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const copy = COPY[kind];

  async function handleDisconnect() {
    if (state.busy) return;
    dispatch({ type: 'submit' });
    try {
      const res = await fetch(`/api/bots/${botId}/${copy.path}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? '해제하지 못했습니다');
      }
      // 서버 컴포넌트(현황판)가 새 상태를 다시 그린다 — 둘 다 꺼졌으면 갈림길로 돌아간다.
      router.refresh();
    } catch (err) {
      dispatch({ type: 'fail', error: err instanceof Error ? err.message : '해제하지 못했습니다' });
    }
  }

  if (!state.open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => dispatch({ type: 'open' })} className="text-destructive hover:text-destructive">
        연결 해제
      </Button>
    );
  }

  return (
    <div role="group" aria-label={copy.title} className="flex w-full flex-col gap-2.5 rounded-[10px] border border-destructive/40 p-3.5">
      <p className="text-sm font-semibold">{copy.title}</p>
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">{copy.body}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="destructive" size="sm" onClick={handleDisconnect} disabled={state.busy}>
          {state.busy ? '처리 중…' : copy.confirm}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => dispatch({ type: 'cancel' })} disabled={state.busy}>
          취소
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
