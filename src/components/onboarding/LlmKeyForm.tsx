'use client';

// 봇 설정 › API 키 (BYOK) — 「답변 지식」 화면의 두 번째 탭. 계획 §B-5.
//
// 이 화면이 정하는 것은 «누구 돈으로 답하는가»다. 키를 넣으면 그 사람의
// provider·모델·요금으로 나가고, 안 넣으면 우리 플랫폼 키로 돈다(상한이 낮다).
//
// 지키는 것 셋:
//  1. 키 원문은 저장 뒤 다시 보여주지 않는다. 마지막 4자만 남는다 — 서버도 되돌려주지 않는다
//  2. 상한 문구에 숫자를 «박지 않는다». 봇마다 다르다 — 키 없음 100(플랫폼 키),
//     키 있음 한도 없음(한때 300), 그리고 `daily_reply_limit` 예외가 걸린 봇은 그 값이 둘 다 이긴다
//     (데모 봇 2000). 고정 문구를 쓰면 그 운영자에게 거짓말이 된다. GET 의 dailyLimit 을 그대로 쓴다
//  3. 모델 목록은 닫힌 집합이 아니다. 「직접 입력」을 두고, 그 대가를 화면이 정직하게 말한다
//     — 잘못된 이름은 저장은 되고 «첫 답변에서» 실패로 드러난다

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, AlertTriangle, KeyRound } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MODELS, PROVIDER_LABELS, modelLabel, validateModelId, type LlmProvider } from '@/lib/llm/models';
// 형식 필터만 쓴다. key.ts 는 provider 로 실제 요청을 보내는 verifyKey 를 들고 있어
// 클라이언트 번들에 실을 이유가 없다 — 그래서 의존성 0 인 key-format.ts 로 나눠 뒀다.
import { checkKeyFormat } from '@/lib/llm/key-format';
import { DEFAULT_LIMITS, PLATFORM_MODEL_LABEL, limitAfterKeyRemoval } from '@/lib/llm/limits';
import { HOLDING_MESSAGE } from '@/lib/bot/holding';
// 3단계 입력 마크업은 등록 화면(`/bots/new`)과 한 벌을 쓴다.
import { LlmKeyFields, ModelPicker } from '@/components/onboarding/LlmKeyFields';
// 「자동」·「직접 입력」을 접는 규칙은 의존성 0 인 원본에서 직접 가져온다 —
// 컴포넌트 파일을 경유해 재수출하면 값이 어디서 오는지가 한 겹 흐려진다.
import { CUSTOM_MODEL, draftModelValue } from '@/lib/llm/model-choice';

interface LlmKeyFormProps {
  botId: string;
  serviceName: string;
}

/** GET /api/bots/[id]/llm-key 의 응답. 키 원문도 암호문도 여기에 없다. */
interface KeyState {
  provider: LlmProvider | null;
  model: string | null;
  effectiveModel: string | null;
  hasKey: boolean;
  keyLast4: string | null;
  verifiedAt: string | null;
  failedAt: string | null;
  failedReason: string | null;
  /** null = 한도 없음(운영자 키) */
  dailyLimit: number | null;
  dailyLimitOverridden: boolean;
}

type Mode = 'view' | 'key' | 'model';
type Status = { kind: 'ok' | 'error'; message: string } | null;

export function LlmKeyForm({ botId, serviceName }: LlmKeyFormProps) {
  const [state, setState] = useState<KeyState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [mode, setMode] = useState<Mode>('view');
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  // 초안
  // 키가 없는 봇의 초안 provider 는 «플랫폼과 같은» anthropic 으로 시작한다(등록 화면 「내 API 키로 시작」과 동일).
  // DB 의 llm_provider 는 키 없이도 'gemini' 기본값이 들어 있어, 그걸 따르면 두 화면이 다른 회사를 먼저 보여준다.
  const [provider, setProvider] = useState<LlmProvider>('anthropic');
  const [modelChoice, setModelChoice] = useState<string>('');
  const [customModel, setCustomModel] = useState('');
  const [key, setKey] = useState('');

  // 서버 상태 → 초안. 불러올 때·저장 뒤·취소 때 전부 이 하나를 탄다.
  // 목록 밖 모델(직접 입력)은 「직접 입력…」 + 입력란으로 되살린다 — 안 그러면 <select> 가
  // 값을 못 찾아 「자동」으로 보이는데 저장은 옛 이름으로 나간다(QA 2026-09-10 에서 실측).
  // 키를 제거한 뒤에도 서버가 지운 모델이 화면에 남지 않게 같은 경로로 되돌린다.
  const applyDraft = useCallback((data: KeyState) => {
    setProvider(data.hasKey && data.provider ? data.provider : 'anthropic');
    if (data.model && !inList(data.provider, data.model)) {
      setModelChoice(CUSTOM_MODEL);
      setCustomModel(data.model);
    } else {
      setModelChoice(data.model ?? '');
      setCustomModel('');
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/bots/${botId}/llm-key`);
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      const data = (await res.json()) as KeyState;
      setState(data);
      setLoadError(false);
      applyDraft(data);
      setMode(data.hasKey ? 'view' : 'key');
    } catch {
      setLoadError(true);
    }
  }, [botId, applyDraft]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadError) {
    return (
      <p className="py-6 text-sm text-destructive">
        키 설정을 불러오지 못했습니다. 새로고침해 주세요.
      </p>
    );
  }
  if (!state) {
    return (
      <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> 불러오는 중…
      </p>
    );
  }

  // ── 초안에서 서버로 보낼 모델 값. null = "안 골랐다"(추천 기본값을 탄다)
  // 접는 규칙은 LlmKeyFields 와 한 벌을 쓴다 — 화면이 보여주는 값과 보내는 값이 갈리면 안 된다.
  const draftModel = draftModelValue(modelChoice, customModel);
  // 아래 두 검사는 **버튼을 잠글지**만 정한다. 오류 «문구»는 LlmKeyFields 가 같은 함수로 그린다.
  const modelCheck = validateModelId(draftModel);
  const keyCheck = mode === 'key' ? checkKeyFormat(provider, key) : ({ ok: true } as const);

  async function send(init: RequestInit, okMessage: string) {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/bots/${botId}/llm-key`, init);
      const data = (await res.json().catch(() => null)) as (KeyState & { error?: string }) | null;
      if (!res.ok) {
        setStatus({ kind: 'error', message: data?.error ?? '저장하지 못했습니다' });
        return;
      }
      if (data) {
        setState(data);
        applyDraft(data);
      }
      setKey('');
      setConfirmRemove(false);
      setMode(data?.hasKey ? 'view' : 'key');
      setStatus({ kind: 'ok', message: okMessage });
    } catch {
      setStatus({ kind: 'error', message: '네트워크 오류로 저장하지 못했습니다' });
    } finally {
      setBusy(false);
    }
  }

  const saveKey = () =>
    send(
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, key, model: draftModel }),
      },
      '키를 확인하고 저장했어요. 지금부터 이 키로 답합니다',
    );

  const saveModel = () =>
    send(
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: draftModel }),
      },
      '모델을 바꿨어요. 키는 그대로입니다',
    );

  const removeKey = () =>
    send({ method: 'DELETE' }, '키를 제거했어요. 이제 기본 설정으로 답합니다');

  return (
    <div className="flex max-w-[660px] flex-col gap-6">
      <BudgetNotice state={state} draftProvider={provider} editing={mode === 'key'} />

      {state.failedAt && mode === 'view' && (
        <div className="flex items-start gap-2.5 border-l-2 border-destructive pl-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <div className="space-y-0.5 text-sm">
            <p className="font-semibold text-destructive">
              {state.failedReason ?? '마지막 호출이 실패했어요'}
            </p>
            <p className="text-xs text-muted-foreground">
              그 사이 들어온 피드백은 저장돼 있고 「대화」에서 볼 수 있어요. 잃은 건 자동 답변뿐입니다.
            </p>
          </div>
        </div>
      )}

      {mode === 'view' && state.hasKey ? (
        <SavedKeyCard
          state={state}
          busy={busy}
          confirmRemove={confirmRemove}
          onChangeModel={() => {
            setStatus(null);
            setMode('model');
          }}
          onReplaceKey={() => {
            setStatus(null);
            setKey('');
            setMode('key');
          }}
          onAskRemove={() => setConfirmRemove(true)}
          onCancelRemove={() => setConfirmRemove(false)}
          onRemove={removeKey}
        />
      ) : (
        <div className="flex flex-col gap-6 border-t border-border pt-5">
          {mode === 'key' ? (
            <LlmKeyFields
              provider={provider}
              modelChoice={modelChoice}
              customModel={customModel}
              apiKey={key}
              disabled={busy}
              onProviderChange={setProvider}
              onModelChoiceChange={setModelChoice}
              onCustomModelChange={setCustomModel}
              onApiKeyChange={setKey}
            />
          ) : (
            /* 키가 이미 있는 봇에서 모델만 바꾸는 모드 — 키를 다시 묻지 않는다(§B-3). */
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">모델 바꾸기</h2>
              <ModelPicker
                provider={provider}
                choice={modelChoice}
                custom={customModel}
                disabled={busy}
                onChoice={setModelChoice}
                onCustom={setCustomModel}
              />
              {!modelCheck.ok && <p className="text-xs text-destructive">{modelCheck.error}</p>}
            </section>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
            {mode === 'key' ? (
              <Button onClick={saveKey} disabled={busy || !key || !keyCheck.ok || !modelCheck.ok}>
                {busy ? <Loader2 className="animate-spin" /> : '확인하고 저장'}
              </Button>
            ) : (
              <Button onClick={saveModel} disabled={busy || !modelCheck.ok}>
                {busy ? <Loader2 className="animate-spin" /> : '모델 저장'}
              </Button>
            )}
            {state.hasKey && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setStatus(null);
                  setKey('');
                  applyDraft(state);
                  setMode('view');
                }}
              >
                취소
              </Button>
            )}
          </div>
        </div>
      )}

      {status && (
        <p
          className={cn(
            'text-xs',
            status.kind === 'ok' ? 'text-brand-strong' : 'text-destructive',
          )}
        >
          {status.message}
        </p>
      )}

      {/* 상한 예외(daily_reply_limit)가 걸린 봇에는 첫 문장이 거짓이 된다 — 예외가 이기므로 숨긴다 */}
      {!state.dailyLimitOverridden && !state.hasKey && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          키를 넣지 않으면 {serviceName} 봇은 하루 {DEFAULT_LIMITS.noKey.toLocaleString('ko-KR')}건까지
          무료로 답해요(기본 모델 {PLATFORM_MODEL_LABEL}). 답변 지식에 없는 사실 질문은 지어내지 않고
          &ldquo;{HOLDING_MESSAGE}&rdquo;로 넘겨 「대화」에 &ldquo;담당자 확인 필요&rdquo;로
          표시됩니다. 내 API 키를 넣으면 모델을 직접 고르고 한도 없이 답해요. 요금은 내 키로
          청구됩니다.
        </p>
      )}
    </div>
  );
}

// ── 조각들 ──────────────────────────────────────────

function inList(provider: LlmProvider | null, model: string): boolean {
  if (!provider) return false;
  return MODELS[provider].some((m) => m.id === model);
}

/**
 * 상한 안내. **숫자를 문자열에 박지 않는다** — 지금 값은 서버가 준 것을 쓰고,
 * 늘어날 값은 고른 provider 로 계산한다.
 *
 * 상한 «예외»가 걸린 봇(데모 봇 2000)에는 "키를 넣으면 늘어나요"를 아예 말하지 않는다.
 * 예외가 이기기 때문에 늘어나지 않고, 그 말은 그 운영자에게 거짓말이다.
 */
function BudgetNotice({
  state,
  draftProvider,
  editing,
}: {
  state: KeyState;
  draftProvider: LlmProvider;
  editing: boolean;
}) {
  const showUpgrade = editing && !state.hasKey && !state.dailyLimitOverridden;

  if (state.dailyLimit === null) {
    return (
      <p className="text-sm leading-relaxed text-muted-foreground">
        내 키로 <b className="font-semibold text-foreground">한도 없이</b> 답해요. 요금은 그 키로 청구됩니다.
      </p>
    );
  }

  return (
    <p className="text-sm leading-relaxed text-muted-foreground">
      지금은 하루 <b className="font-semibold tabular-nums text-foreground">{state.dailyLimit.toLocaleString('ko-KR')}건</b>
      까지 {!state.hasKey && !state.dailyLimitOverridden ? '무료로' : '자동으로'} 답해요.
      {!state.hasKey && !state.dailyLimitOverridden && ` 기본 모델은 ${PLATFORM_MODEL_LABEL} 입니다.`}
      {showUpgrade && (
        <>
          {' '}
          {PROVIDER_LABELS[draftProvider]} 키를 넣으면 <b className="font-semibold text-foreground">한도 없이</b> 답하고,
          요금은 그 키로 청구됩니다.
        </>
      )}
    </p>
  );
}

function SavedKeyCard({
  state,
  busy,
  confirmRemove,
  onChangeModel,
  onReplaceKey,
  onAskRemove,
  onCancelRemove,
  onRemove,
}: {
  state: KeyState;
  busy: boolean;
  confirmRemove: boolean;
  onChangeModel: () => void;
  onReplaceKey: () => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
}) {
  const provider = state.provider;
  return (
    <div className="flex flex-col gap-5 border-t border-border pt-5">
      <div className="flex items-start gap-2.5">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <dl className="grid flex-1 gap-2 text-sm sm:grid-cols-[7rem_minmax(0,1fr)]">
          <dt className="text-muted-foreground">제공사</dt>
          <dd className="font-medium">{provider ? PROVIDER_LABELS[provider] : '알 수 없음'}</dd>

          <dt className="text-muted-foreground">모델</dt>
          <dd className="font-medium">
            {state.model
              ? provider
                ? modelLabel(provider, state.model)
                : state.model
              : `(기본) ${state.effectiveModel ?? '-'}`}
          </dd>

          <dt className="text-muted-foreground">키</dt>
          <dd className="font-medium tabular-nums">
            {state.keyLast4 ? `…${state.keyLast4}` : '저장됨'}
          </dd>

          {state.verifiedAt && (
            <>
              <dt className="text-muted-foreground">확인한 날</dt>
              <dd className="tabular-nums text-muted-foreground">
                {new Date(state.verifiedAt).toLocaleDateString('ko-KR')}
              </dd>
            </>
          )}
        </dl>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        {/* 모델만 바꿀 때는 키를 다시 묻지 않는다 */}
        <Button variant="outline" size="sm" disabled={busy} onClick={onChangeModel}>
          모델 변경
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={onReplaceKey}>
          키 교체
        </Button>
        {confirmRemove ? (
          <>
            <Button variant="destructive" size="sm" disabled={busy} onClick={onRemove}>
              {busy ? <Loader2 className="animate-spin" /> : '정말 제거'}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={onCancelRemove}>
              취소
            </Button>
            <span className="text-xs text-muted-foreground">
              {/* 숫자를 박지 않는다 — 상한 예외 봇은 예외 값으로 돌아간다(I-26) */}
              제거하면 기본 설정(무료 하루 {limitAfterKeyRemoval(state).toLocaleString('ko-KR')}건)으로 돌아가요.
            </span>
          </>
        ) : (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onAskRemove}>
            키 제거
          </Button>
        )}
      </div>
    </div>
  );
}
