'use client';

// 채널톡 연결 — 세 단계짜리 갈래.
//
// 예전 화면은 **키를 저장해야 「붙이는 순서」가 나타났다.** 운영자는 총 몇 단계인지 모른 채
// 첫 칸을 채웠고, 저장하고 나서야 남은 일이 셋 더 있다는 걸 알았다. 이제 세 단계가 처음부터
// 다 보이고, 지나온 단계는 한 줄로 접힌다.
//
// 키 발급 절차를 화면 안에서 끝까지 안내하는 것도 이 회차의 몫이다. 예전엔 「설정 → 보안 및
// 개발 → API 에서 발급합니다」 한 줄이 전부였는데, 실측(2026-09-14)에서 나온 함정이 하나 있다 —
// **무료 플랜에서는 「새 인증 키 만들기」 버튼이 `disabled` 가 아니라 `pointer-events: none`** 이라
// 회색으로 보이지도 않으면서 눌러도 아무 일이 안 일어난다. 운영자가 「내가 잘못 눌렀나」 하게
// 되는 자리라, 그 경고를 키를 넣기 «전»에 둔다.
//
// 이 채널에서 Feedloop 은 «말하지 않는다». 유저 응대는 채널톡 ALF·상담원 몫이고 우리가 보내는
// 것은 되돌림 하나뿐이다 — 화면 문구도 그렇게 적는다.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Loader2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConnectStep, ConnectSteps, Howto, HowtoStep, Kbd } from '@/components/onboarding/ConnectSteps';
import { ConnectedPanel, WaitingLine } from '@/components/onboarding/ConnectStatus';
import { useConnectionStatus } from '@/lib/hooks/useConnectionStatus';
import { cn } from '@/lib/utils';

interface ChannelConfig {
  configured: boolean;
  channel_slug: string | null;
  channel_id: string | null;
  channel_bot_name: string | null;
  webhookUrl: string | null;
  deskUrl: string;
  connected: boolean;
  /** 채널톡 `?token=` 을 대조 중인가. 값 자체는 서버가 절대 돌려주지 않는다. */
  verifyTokenSet: boolean;
}

interface Draft {
  access_key: string;
  access_secret: string;
  channel_slug: string;
  channel_id: string;
  bot_name: string;
}

type Status = {
  kind: 'ok' | 'error';
  message: string;
  /** 운영자가 켜 둔 설정을 «우리가» 바꾼 경우. 조용히 넘기지 않고 따로 한 줄 둔다. */
  changed?: string;
} | null;

const EMPTY_DRAFT: Draft = {
  access_key: '',
  access_secret: '',
  channel_slug: '',
  channel_id: '',
  bot_name: '',
};

/** 시크릿 세그먼트를 가린다. 어디까지가 공개해도 되는 주소인지 눈으로 구분되게 남겨 둔다. */
function maskWebhookUrl(url: string): string {
  const cut = url.lastIndexOf('/');
  if (cut < 0) return '••••••';
  return `${url.slice(0, cut + 1)}${'•'.repeat(12)}`;
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  help?: string;
  type?: string;
  optional?: boolean;
}

function Field({ label, value, onChange, placeholder, help, type, optional }: FieldProps) {
  const t = useTranslations('connect');
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="text-[12.5px] font-semibold">
        {label}
        {optional ? (
          <span className="ml-1 font-normal text-muted-foreground">{t('ct.optional')}</span>
        ) : (
          <span className="ml-1 text-brand-strong">{t('ct.required')}</span>
        )}
      </h4>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
      />
      {help && <p className="text-xs leading-relaxed text-faint">{help}</p>}
    </section>
  );
}

/** 화면 안에서 한 번만 쓰는 경고 상자. 노란 계열은 이 앱에서 「고장이 아니라 제약」을 뜻한다 */
function Callout({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2.5 rounded-[10px] border border-[#e8d5aa] bg-[#fff8ea] px-3.5 py-3 text-[13px] leading-relaxed text-[#8a5c06] dark:border-[#e2b34f]/35 dark:bg-[#e2b34f]/10 dark:text-[#e2b34f]">
      <TriangleAlert className="mt-0.5 h-[15px] w-[15px] shrink-0" aria-hidden />
      <span>{children}</span>
    </div>
  );
}

/**
 * 저장·회전 결과 한 줄.
 *
 * **단계 블록 밖에 둔다.** 안에 두면 저장에 성공하는 순간 `configured` 가 true 가 되어
 * 그 블록이 언마운트되고, 메시지를 띄운 동작이 그 메시지를 지운다. 특히 `changed`
 * (「자동 PR 이 승인 모드로 바뀌었어요」)는 **우리가 운영자 설정을 바꾼 사실을 알리는 유일한
 * 경로**라 깜빡이면 안 된다. 회전은 더 나빴다 — 그 버튼이 보이는 상태에서는 예전 자리의
 * StatusLine 이 아예 렌더되지 않아 성공도 실패도 무음이었다(주소를 즉시 무효로 만드는 동작인데).
 */
function StatusLine({ status }: { status: Status }) {
  if (!status) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className={cn('text-xs', status.kind === 'ok' ? 'text-brand-strong' : 'text-destructive')}>
        {status.message}
      </p>
      {status.changed && (
        <p className="text-xs leading-relaxed text-[#8a5c06] dark:text-[#e2b34f]">{status.changed}</p>
      )}
    </div>
  );
}

interface ChannelTalkConnectGuideProps {
  botId: string;
  /**
   * 봇 이름 입력란의 기본값. 되돌림이 고객사 채널에 이 이름으로 찍히므로 비워 두면 운영자가
   * 「Feedloop …」 같은 우리 이름을 넣기 쉽다 — 실계정 검증에서 실제로 그렇게 찍혔다.
   * 서비스 이름으로 미리 채우고, 이미 저장된 이름이 있으면 그것이 이긴다.
   */
  serviceName: string;
  initiallyConnected: boolean;
}

export function ChannelTalkConnectGuide({
  botId,
  serviceName,
  initiallyConnected,
}: ChannelTalkConnectGuideProps) {
  const t = useTranslations('connect');
  const rich = {
    kbd: (chunks: ReactNode) => <Kbd>{chunks}</Kbd>,
    b: (chunks: ReactNode) => <b className="font-semibold text-foreground">{chunks}</b>,
  };
  const { connected, polling, resume } = useConnectionStatus(
    botId,
    (data) => data.channel_connected,
    initiallyConnected,
  );

  const [config, setConfig] = useState<ChannelConfig | null>(null);
  // ICU select 인자 — 채널 주소가 없으면 'none'
  const slug = config?.channel_slug || 'none';
  // 서비스 이름은 60자, 봇 이름은 40자까지다(channel-registration.ts). 넘치면 잘라서 넣는다 —
  // 기본값이 서버 검증에 걸리면 운영자는 자기가 안 쓴 값 때문에 400 을 본다.
  // 코드 포인트 단위로 자른다 — UTF-16 slice 는 이모지 경계에서 외톨이 서로게이트를 남기고,
  // 그 값이 나중에 전송 API 의 encodeURIComponent 에서 URIError 를 내 되돌림이 조용히 안 나간다.
  const [draft, setDraft] = useState<Draft>({
    ...EMPTY_DRAFT,
    bot_name: Array.from(serviceName.trim()).slice(0, 40).join(''),
  });
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  // 채널톡이 웹훅 등록 직후 보여주는 `?token=` 값. 저장하면 비운다 — 평문을 화면에 둘 이유가 없다.
  const [verifyToken, setVerifyToken] = useState('');
  const [savingVerify, setSavingVerify] = useState(false);
  const [verifyStatus, setVerifyStatus] = useState<Status>(null);
  // 연결된 뒤 키를 바꾸려면 명시적으로 연다 — 실수로 덮어쓰지 않게.
  const [editing, setEditing] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch(`/api/bots/${botId}/channel`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as ChannelConfig;
      setConfig(data);
      setDraft((prev) => ({
        ...prev,
        channel_slug: data.channel_slug ?? prev.channel_slug,
        channel_id: data.channel_id ?? prev.channel_id,
        bot_name: data.channel_bot_name ?? prev.bot_name,
      }));
    } catch {
      // 일시적 실패는 화면을 막지 않는다 — 저장할 때 다시 알게 된다.
    }
  }, [botId]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  // 연결이 성사되는 순간 직전 안내는 사실이 아니게 된다 — 「아래 주소를 채널톡에 등록해
  // 주세요」가 「들어오고 있어요」 아래에 남으면 운영자는 아직 할 일이 있는 줄 안다.
  useEffect(() => {
    if (connected) setStatus(null);
  }, [connected]);

  const handleSave = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/bots/${botId}/channel`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t('ct.errors.save'));

      // 평문 키를 화면에 남겨 둘 이유가 없다. 저장에 성공한 순간 비운다.
      setDraft((prev) => ({ ...prev, access_key: '', access_secret: '' }));
      setEditing(false);
      setStatus({
        kind: 'ok',
        message: t('ct.status.keySaved'),
        changed: json.prModeChanged
          ? t('ct.status.prModeChanged')
          : undefined,
      });
      await loadConfig();
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : t('ct.errors.save'),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleRotate = async () => {
    setRotating(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/bots/${botId}/channel?action=rotate`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t('ct.errors.rotate'));
      setStatus({
        kind: 'ok',
        message: t('ct.status.rotated'),
      });
      setRevealed(true);
      await loadConfig();
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : t('ct.errors.rotate'),
      });
    } finally {
      setRotating(false);
    }
  };

  /** 빈 문자열을 보내면 해제다. 서버가 「대조 중인가」 만 돌려준다. */
  const submitVerifyToken = async (value: string) => {
    setSavingVerify(true);
    setVerifyStatus(null);
    try {
      const res = await fetch(`/api/bots/${botId}/channel?action=verify_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verify_token: value }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t('ct.errors.verifySave'));
      setVerifyToken('');
      setVerifyStatus({
        kind: 'ok',
        message: json.verifyTokenSet
          ? t('ct.status.verifyOn')
          : t('ct.status.verifyOff'),
      });
      await loadConfig();
    } catch (err) {
      setVerifyStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : t('ct.errors.verifySave'),
      });
    } finally {
      setSavingVerify(false);
    }
  };

  const handleCopy = async () => {
    if (!config?.webhookUrl) return;
    try {
      await navigator.clipboard.writeText(config.webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const configured = Boolean(config?.configured);
  const showForm = !configured || editing;
  const canSave =
    Boolean(draft.access_key.trim()) &&
    Boolean(draft.access_secret.trim()) &&
    Boolean(draft.channel_slug.trim()) &&
    Boolean(draft.bot_name.trim());

  /* ── 1단계 본문: 키 발급 절차 + 폼 ────────────────────────── */
  const keyStepBody = (
    <>
      <Howto>
        <HowtoStep index={1}>{t.rich('ct.keyStep.s1', rich)}</HowtoStep>
        <HowtoStep index={2}>{t.rich('ct.keyStep.s2', rich)}</HowtoStep>
        <HowtoStep index={3}>{t.rich('ct.keyStep.s3', rich)}</HowtoStep>
        <HowtoStep index={4}>{t.rich('ct.keyStep.s4', rich)}</HowtoStep>
      </Howto>

      <Callout>{t.rich('ct.keyStep.callout', { b: (chunks) => <b className="font-bold">{chunks}</b> })}</Callout>

      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <a href={config?.deskUrl || 'https://desk.channel.io'} target="_blank" rel="noreferrer noopener">
            {t('ct.openDesk')} <span aria-hidden>↗</span>
          </a>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href={`/bots/${botId}/connect?via=widget`}>{t('ct.startWithWidget')}</Link>
        </Button>
      </div>

      <div className="grid gap-4 pt-1 sm:grid-cols-2">
        <Field
          label={t('ct.fields.accessKey')}
          value={draft.access_key}
          onChange={(v) => setDraft({ ...draft, access_key: v })}
          placeholder={t('ct.fields.accessKeyPlaceholder')}
        />
        <Field
          label={t('ct.fields.accessSecret')}
          type="password"
          value={draft.access_secret}
          onChange={(v) => setDraft({ ...draft, access_secret: v })}
          placeholder={t('ct.fields.accessSecretPlaceholder')}
        />
        <Field
          label={t('ct.fields.channelSlug')}
          value={draft.channel_slug}
          onChange={(v) => setDraft({ ...draft, channel_slug: v })}
          placeholder={t('ct.fields.channelSlugPlaceholder')}
          help={t('ct.fields.channelSlugHelp')}
        />
        <Field
          label={t('ct.fields.botName')}
          value={draft.bot_name}
          onChange={(v) => setDraft({ ...draft, bot_name: v })}
          placeholder={t('ct.botNamePlaceholder', { name: serviceName.trim() || t('ct.defaultServiceName') })}
          help={t('ct.fields.botNameHelp')}
        />
      </div>

      <Field
        label={t('ct.fields.channelId')}
        optional
        value={draft.channel_id}
        onChange={(v) => setDraft({ ...draft, channel_id: v })}
        placeholder={t('ct.fields.channelIdPlaceholder')}
        help={t('ct.fields.channelIdHelp')}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={handleSave} disabled={saving || !canSave}>
          {saving ? <Loader2 className="animate-spin" /> : t('ct.verifyAndSave')}
        </Button>
        {configured && (
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => {
              setEditing(false);
              setStatus(null);
              setDraft((prev) => ({ ...prev, access_key: '', access_secret: '' }));
            }}
          >
            {t('ct.cancel')}
          </Button>
        )}
      </div>
      <p className="text-xs leading-relaxed text-faint">
        {t('ct.saveNote')}
      </p>
    </>
  );

  /* ── 2단계 본문: 웹훅 주소 + 등록 절차 + 토큰 ─────────────── */
  const webhookStepBody = (
    <>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-2.5">
        <code className="block min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-[10px] bg-muted px-3.5 py-3 font-mono text-xs leading-relaxed text-foreground">
          {config?.webhookUrl
            ? revealed
              ? config.webhookUrl
              : maskWebhookUrl(config.webhookUrl)
            : t('ct.loadingAddress')}
        </code>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" onClick={() => setRevealed((v) => !v)}>
            {revealed ? t('ct.hide') : t('ct.show')}
          </Button>
          <Button onClick={handleCopy} disabled={!config?.webhookUrl}>
            {copied ? t('ct.copied') : t('ct.copy')}
          </Button>
        </div>
      </div>

      <Howto>
        <HowtoStep index={1}>{t.rich('ct.webhook.s1', rich)}</HowtoStep>
        <HowtoStep index={2}>{t.rich('ct.webhook.s2', rich)}</HowtoStep>
        <HowtoStep index={3}>{t.rich('ct.webhook.s3', rich)}</HowtoStep>
        <HowtoStep index={4}>{t.rich('ct.webhook.s4', rich)}</HowtoStep>
      </Howto>

      <p className="text-[13px] leading-relaxed text-muted-foreground">
        {t('ct.secretNote')}
      </p>

      <div className="flex flex-col gap-2 sm:max-w-[460px]">
        <h4 className="text-[12.5px] font-semibold">
          {t('ct.tokenLabel')}<span className="ml-1 font-normal text-muted-foreground">{t('ct.optional')}</span>
        </h4>
        {config?.verifyTokenSet && (
          <p className="text-[13px] text-muted-foreground">
            {t.rich('ct.verifyActive', rich)}
          </p>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <Input
            value={verifyToken}
            onChange={(e) => setVerifyToken(e.target.value)}
            placeholder={config?.verifyTokenSet ? t('ct.tokenPlaceholderChange') : t('ct.tokenPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            aria-label={t('ct.tokenLabel')}
          />
          <Button
            variant="outline"
            disabled={savingVerify || !verifyToken.trim()}
            onClick={() => submitVerifyToken(verifyToken)}
          >
            {savingVerify ? <Loader2 className="animate-spin" /> : t('ct.saveToken')}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {config?.verifyTokenSet && (
            <Button
              variant="ghost"
              size="sm"
              disabled={savingVerify}
              onClick={() => submitVerifyToken('')}
            >
              {t('ct.clearCheck')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={handleRotate} disabled={rotating}>
            {rotating ? <Loader2 className="animate-spin" /> : t('ct.rotate')}
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-faint">
          {t('ct.rotateNote')}
        </p>
        <StatusLine status={verifyStatus} />
      </div>
    </>
  );

  /* ── 연결이 끝난 뒤 ───────────────────────────────────────── */
  if (connected && !editing) {
    return (
      <div className="flex max-w-[860px] flex-col gap-6">
        <ConnectedPanel
          title={t('ct.connected.title', { slug })}
          description={t('ct.connected.description')}
        >
          <Button asChild>
            <Link href="/inbox">{t('ct.viewInbox')}</Link>
          </Button>
          <Button asChild variant="outline">
            <a href={config?.deskUrl || 'https://desk.channel.io'} target="_blank" rel="noreferrer noopener">
              {t('ct.openDesk')} <span aria-hidden>↗</span>
            </a>
          </Button>
        </ConnectedPanel>

        <StatusLine status={status} />

        <details className="border-t border-border pt-4">
          <summary className="cursor-pointer text-sm font-semibold">{t('ct.settingsSummary')}</summary>
          <div className="mt-4 flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
              <span className="font-semibold">
                {t('ct.connected.line', { slug })}
              </span>
              <span className="text-muted-foreground">
                {t('ct.connected.notifyName', { name: config?.channel_bot_name || '—' })}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setStatus(null);
                  setEditing(true);
                }}
              >
                {t('ct.replaceKey')}
              </Button>
            </div>
            {webhookStepBody}
          </div>
        </details>

        {/* 여기 있던 「웹 위젯도 함께 띄우세요」 권유는 2026-09-20 에 뺐다 —
            입구는 한 번에 하나다(`lib/connect/exclusive.ts`). */}

        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('ct.footnote')}
        </p>
      </div>
    );
  }

  /* ── 연결 전 — 세 단계 ────────────────────────────────────── */
  return (
    <div className="flex max-w-[860px] flex-col gap-6">
      <StatusLine status={status} />

      <ConnectSteps>
        <ConnectStep
          state={configured && !editing ? 'done' : 'now'}
          index={1}
          title={configured && !editing ? t('ct.steps.keyDone') : t('ct.steps.keyTodo')}
        >
          {showForm ? (
            keyStepBody
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13.5px]">
              <span className="text-muted-foreground">
                {t.rich('ct.steps.keyConnected', { ...rich, slug, name: config?.channel_bot_name || '—' })}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setStatus(null);
                  setEditing(true);
                }}
              >
                {t('ct.replaceKey')}
              </Button>
            </div>
          )}
        </ConnectStep>

        <ConnectStep
          state={connected ? 'done' : configured && !editing ? 'now' : 'todo'}
          index={2}
          title={connected ? t('ct.steps.webhookDone') : t('ct.steps.webhookTodo')}
        >
          {connected ? (
            // 키 교체 중이다. 주소는 그대로다 — PATCH 는 시크릿을 회전하지 않는다
            // (라우트 주석: 「회전은 운영자가 명시적으로 누를 때만」).
            <p className="text-[13.5px] leading-relaxed text-muted-foreground">
              {t('ct.steps.webhookDoneNote')}
            </p>
          ) : configured && !editing ? (
            webhookStepBody
          ) : (
            <p className="text-[13.5px] leading-relaxed text-muted-foreground">
              {t('ct.steps.webhookWait')}
            </p>
          )}
        </ConnectStep>

        <ConnectStep
          // 「지금 할 것」은 하나여야 한다. 예전엔 이 단계가 영구 todo(회색)인데 그 «안»에서
          // 코랄 점이 뛰는 대기 줄이 돌아, 단계 문법과 화면이 서로 다른 말을 했다.
          state={connected ? 'done' : configured && !editing ? 'now' : 'todo'}
          index={3}
          title={connected ? t('ct.steps.testDone') : t('ct.steps.testTodo')}
        >
          {connected ? (
            <p className="text-[13.5px] leading-relaxed text-muted-foreground">
              {t('ct.steps.testDoneNote')}
            </p>
          ) : (
            <>
              <p className="text-[13.5px] leading-relaxed text-muted-foreground">
                {t('ct.steps.testNote')}
              </p>
              {configured && !editing && (
                <WaitingLine
                  polling={polling}
                  onResume={resume}
                  title={t('ct.steps.waiting')}
                  description={t('ct.steps.waitingNote')}
                />
              )}
            </>
          )}
        </ConnectStep>
      </ConnectSteps>

      <p className="text-xs leading-relaxed text-muted-foreground">
        {t('ct.footnote')}
      </p>
    </div>
  );
}
