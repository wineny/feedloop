'use client';

// 「서비스 삭제」(I-25) — 하드 삭제. 되돌릴 수 없어서 두 단계다: 누르면 그 자리에 확인 칸이 펼쳐지고,
// 서비스 이름을 그대로 쳐야 버튼이 산다. window.confirm 을 안 쓰는 이유: 무엇이 지워지는지
// 한 문장으로 못 담고, 브라우저 자동화가 그 대화상자에 막힌다.
//
// 지워지는 범위는 DB 의 ON DELETE CASCADE 가 정한다(bots → 대화·메시지·인사이트·묶음·응답·
// 수정 PR 기록·사용량·묶기 상태·메일 발송 기록). GitHub 에 이미 만든 PR·브랜치는 남는다 —
// 그건 우리 DB 가 아니다.

import { useReducer } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useBotScope } from '@/lib/scope/BotScopeProvider';

interface DeleteBotButtonProps {
  botId: string;
  serviceName: string;
  disabled?: boolean;
}

interface DeleteState {
  open: boolean;
  typed: string;
  busy: boolean;
  error: string | null;
}

type DeleteAction =
  | { type: 'open' }
  | { type: 'cancel' }
  | { type: 'type'; value: string }
  | { type: 'submit' }
  | { type: 'fail'; error: string };

const INITIAL: DeleteState = { open: false, typed: '', busy: false, error: null };

function reducer(state: DeleteState, action: DeleteAction): DeleteState {
  switch (action.type) {
    case 'open':
      return { ...INITIAL, open: true };
    case 'cancel':
      return INITIAL;
    case 'type':
      return { ...state, typed: action.value, error: null };
    case 'submit':
      return { ...state, busy: true, error: null };
    case 'fail':
      return { ...state, busy: false, error: action.error };
  }
}

export function DeleteBotButton({ botId, serviceName, disabled = false }: DeleteBotButtonProps) {
  const router = useRouter();
  const scope = useBotScope();
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const matches = state.typed.trim() === serviceName.trim();
  const inputId = `delete-bot-${botId}`;

  async function handleDelete() {
    if (!matches || state.busy) return;
    dispatch({ type: 'submit' });
    try {
      const res = await fetch(`/api/bots/${botId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? '삭제하지 못했습니다');
      }
      // 헤더 셀렉터가 지운 봇을 물고 있지 않게 목록부터 새로 읽고, 서버 컴포넌트 목록을 다시 그린다.
      await scope.refresh();
      router.refresh();
    } catch (err) {
      dispatch({ type: 'fail', error: err instanceof Error ? err.message : '삭제하지 못했습니다' });
    }
  }

  if (disabled) {
    return <span className="text-sm font-semibold text-faint">서비스 삭제</span>;
  }

  if (!state.open) {
    return (
      <button
        type="button"
        onClick={() => dispatch({ type: 'open' })}
        className="text-sm font-semibold text-destructive hover:underline"
      >
        서비스 삭제
      </button>
    );
  }

  return (
    <div
      role="group"
      aria-labelledby={`${inputId}-title`}
      className="flex w-full flex-col gap-3 rounded-2xl border border-destructive/40 bg-destructive/[0.03] p-4 sm:p-5"
    >
      <p id={`${inputId}-title`} className="text-sm font-semibold">
        「{serviceName}」을(를) 삭제할까요?
      </p>
      <p className="text-sm leading-relaxed text-muted-foreground">
        대화·피드백·묶음·수정안 기록·답변 지식·API 키가 모두 지워지고 되돌릴 수 없어요. GitHub 에 이미 만든
        PR·브랜치는 그대로 남습니다. 서비스에 붙인 위젯은 더 이상 뜨지 않아요.
      </p>
      <label htmlFor={inputId} className="flex flex-col gap-1.5 text-sm">
        <span>확인을 위해 서비스 이름을 그대로 입력해 주세요</span>
        <Input
          id={inputId}
          value={state.typed}
          onChange={(e) => dispatch({ type: 'type', value: e.target.value })}
          placeholder={serviceName}
          autoComplete="off"
          className="max-w-[320px]"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="destructive" size="sm" onClick={handleDelete} disabled={!matches || state.busy}>
          {state.busy ? '삭제하는 중…' : '영구 삭제'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => dispatch({ type: 'cancel' })} disabled={state.busy}>
          취소
        </Button>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </div>
  );
}
