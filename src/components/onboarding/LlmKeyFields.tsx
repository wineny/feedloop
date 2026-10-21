'use client';

// 운영자 LLM 키 입력 3단계 — **마크업 한 벌**.
//
// 같은 세 칸이 두 화면에 뜬다: 등록 화면(`/bots/new` 의 「AI 답변」 절)과
// 설정 탭(`/bots/[id]/knowledge?tab=key` 의 LlmKeyForm). 사본을 두면 한쪽만 고쳐진다
// — `WIDGET_CHIP_LABELS` 사본이 미리보기만 옛 문구로 남겼던 사고와 같은 계열이다.
// (`lib/widget/chips.ts` 를 하나로 모은 것과 같은 이유)
//
// 이 컴포넌트는 **상태를 갖지 않는다**. 값과 핸들러를 전부 받고, 저장·PATCH·모드 전환은
// 부모가 한다 — 등록 화면은 react-hook-form, 설정 탭은 자체 상태 기계라 서로 다르다.
//
// 검증은 «안에서» 한다(`validateModelId`·`checkKeyFormat` 둘 다 순수 함수다).
// 오류 문구를 prop 으로 받게 하면 두 부모가 서로 다른 문장을 띄울 수 있다.
// 부모는 같은 함수를 한 번 더 불러 «버튼을 잠글지»만 정한다.

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { validationText } from '@/lib/i18n/message';
import { cn } from '@/lib/utils';
import {
  LLM_PROVIDERS,
  MODELS,
  PROVIDER_LABELS,
  RECOMMENDED,
  modelLabel,
  validateModelId,
  type LlmProvider,
} from '@/lib/llm/models';
// 형식 필터만 쓴다. key.ts 는 provider 로 실제 요청을 보내는 verifyKey 를 들고 있어
// 클라이언트 번들에 실을 이유가 없다 — 그래서 의존성 0 인 key-format.ts 로 나눠 뒀다.
import { checkKeyFormat } from '@/lib/llm/key-format';
// 「자동」·「직접 입력」을 서버 값으로 접는 규칙은 의존성 0 인 모듈 하나가 갖는다 —
// 폼 스키마(React 없이 도는 곳)도 같은 규칙을 봐야 한다.
import { CUSTOM_MODEL, draftModelValue } from '@/lib/llm/model-choice';

export interface LlmKeyFieldsProps {
  provider: LlmProvider;
  modelChoice: string;
  customModel: string;
  apiKey: string;
  disabled?: boolean;
  /** 좁은 자리(등록 화면 패널) — 단계 간격을 24px → 16px 로 좁힌다 */
  compact?: boolean;
  onProviderChange: (next: LlmProvider) => void;
  onModelChoiceChange: (next: string) => void;
  onCustomModelChange: (next: string) => void;
  onApiKeyChange: (next: string) => void;
}

export function LlmKeyFields({
  provider,
  modelChoice,
  customModel,
  apiKey,
  disabled = false,
  compact = false,
  onProviderChange,
  onModelChoiceChange,
  onCustomModelChange,
  onApiKeyChange,
}: LlmKeyFieldsProps) {
  const t = useTranslations('llm');
  const tv = useTranslations();
  const modelCheck = validateModelId(draftModelValue(modelChoice, customModel));
  const keyCheck = checkKeyFormat(provider, apiKey);

  // provider 를 바꾸면 모델 선택을 초기화한다. 남겨두면 gemini 모델 id 가
  // anthropic 키로 나가 첫 호출에서 죽고, 운영자는 "모델을 안 건드렸는데 왜"가 된다.
  // 이 초기화를 부모에 맡기면 한쪽 화면만 빠뜨릴 수 있어 여기서 한 벌로 낸다.
  function selectProvider(next: LlmProvider) {
    if (next === provider) return;
    onProviderChange(next);
    onModelChoiceChange('');
    onCustomModelChange('');
  }

  return (
    <div className={cn('flex flex-col', compact ? 'gap-4' : 'gap-6')}>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t('fields.step1')}</h2>
        <div
          role="radiogroup"
          aria-label={t('fields.providerLabel')}
          className="inline-flex flex-wrap rounded-full border border-border-strong p-0.5"
        >
          {LLM_PROVIDERS.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={provider === p}
              disabled={disabled}
              onClick={() => selectProvider(p)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-semibold transition-colors disabled:cursor-not-allowed',
                provider === p
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {PROVIDER_LABELS[p]}
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t('fields.step2')}</h2>
        <ModelPicker
          provider={provider}
          choice={modelChoice}
          custom={customModel}
          disabled={disabled}
          onChoice={onModelChoiceChange}
          onCustom={onCustomModelChange}
        />
        {!modelCheck.ok && <p className="text-xs text-destructive">{validationText(tv, modelCheck)}</p>}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t('fields.step3')}</h2>
        <Input
          type="password"
          value={apiKey}
          disabled={disabled}
          onChange={(e) => onApiKeyChange(e.target.value)}
          placeholder={t('fields.providerKeyPlaceholder', { provider: PROVIDER_LABELS[provider] })}
          autoComplete="off"
          spellCheck={false}
          aria-label={t('fields.keyLabel')}
        />
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {t('fields.keyNote', { provider: PROVIDER_LABELS[provider] })}
        </p>
        {apiKey && !keyCheck.ok && <p className="text-xs text-destructive">{validationText(tv, keyCheck)}</p>}
      </section>
    </div>
  );
}

/**
 * 모델 선택. 설정 탭은 「모델만 변경」 모드에서 이 조각만 따로 쓴다(키를 다시 묻지 않는다).
 *
 * 목록은 **닫힌 집합이 아니다** — provider 가 새 모델을 내면 우리 배포를 기다리게 할 수
 * 없으므로 「직접 입력」을 함께 둔다. 그 대가(저장 시 이름 확인 불가)는 화면이 정직하게 말한다.
 */
/** 모델 id 의 `.` 은 사전 키에서 경로 구분자라 `_` 로 바꾼다 */
const modelKey = (id: string) => id.replace(/\./g, '_');

export function ModelPicker({
  provider,
  choice,
  custom,
  disabled,
  onChoice,
  onCustom,
}: {
  provider: LlmProvider;
  choice: string;
  custom: string;
  disabled: boolean;
  onChoice: (v: string) => void;
  onCustom: (v: string) => void;
}) {
  const t = useTranslations('llm');
  return (
    <div className="space-y-2">
      <select
        value={choice}
        disabled={disabled}
        onChange={(e) => onChoice(e.target.value)}
        aria-label={t('fields.modelLabel')}
        className="h-10 w-full max-w-md rounded-[10px] border border-border-strong bg-background px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <option value="">{t('fields.auto', { model: modelLabel(provider, RECOMMENDED[provider]) })}</option>
        {MODELS[provider].map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
            {m.id === RECOMMENDED[provider] ? ` · ${t('fields.recommended')}` : ''}
            {m.note ? ` — ${t.has(`models.${modelKey(m.id)}`) ? t(`models.${modelKey(m.id)}`) : m.note}` : ''}
          </option>
        ))}
        <option value={CUSTOM_MODEL}>{t('fields.custom')}</option>
      </select>

      {choice === CUSTOM_MODEL && (
        <>
          <Input
            value={custom}
            disabled={disabled}
            onChange={(e) => onCustom(e.target.value)}
            placeholder={t('fields.customPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            aria-label={t('fields.customLabel')}
            className="max-w-md"
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('fields.customNote')}
          </p>
        </>
      )}
    </div>
  );
}
