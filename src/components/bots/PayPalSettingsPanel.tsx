'use client';

// Bot settings › PayPal — the bot's own sandbox keys, its webhook, refund limits and the two switches.
// API: `api/bots/[id]/paypal` (GET/PUT/PATCH/DELETE) and `.../paypal/webhook` (POST). Pure rules
// (cents ↔ dollars, PATCH diff, error code → message key) live in `lib/paypal/settings-form.ts`.
//
// Same UX as the API key tab (LlmKeyForm): the secret is never shown again (last 4 only), replacing keys
// asks for both again, removing asks inline (no window.confirm), and errors are codes translated here.

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { dynamicT } from '@/i18n/dynamic';
import { formatMoney } from '@/lib/paypal/money';
import {
  LIMIT_FIELDS,
  LIMIT_RULES,
  afterLimitsSaved,
  connectionUi,
  currencySymbol,
  disconnectRequest,
  draftFromLimits,
  hasOwnKeys,
  initialConnectionUi,
  keysSaveRequest,
  limitsSaveRequest,
  parseLimitsDraft,
  settingsErrorKey,
  switchRollback,
  switchSettle,
  switchToggle,
  webhookReasonKey,
  type ApiRequest,
  type ConnectionEvent,
  type LimitField,
  type LimitsDraft,
  type PayPalSettingsErrorKey,
  type PayPalSettingsView,
  type PayPalSwitches,
} from '@/lib/paypal/settings-form';

/** Where to create a sandbox app and copy its Client ID and Secret. */
const PAYPAL_DEV_APPS_URL = 'https://developer.paypal.com/dashboard/applications/sandbox';

type Status = { kind: 'ok' | 'error'; message: string } | null;
type Busy = 'save' | 'disconnect' | 'webhook' | 'limits' | null;
type CallResult = { ok: true; view: PayPalSettingsView } | { ok: false; key: PayPalSettingsErrorKey; field?: string };

async function call(url: string, req: ApiRequest): Promise<CallResult> {
  try {
    const res = await fetch(
      url,
      req.body
        ? { method: req.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) }
        : { method: req.method },
    );
    const data = (await res.json().catch(() => null)) as (PayPalSettingsView & { error?: unknown; field?: unknown }) | null;
    if (!res.ok || !data) {
      return { ok: false, key: settingsErrorKey(res.status, data?.error), field: typeof data?.field === 'string' ? data.field : undefined };
    }
    return { ok: true, view: data };
  } catch {
    return { ok: false, key: 'network' };
  }
}

export function PayPalSettingsPanel({ botId, initial }: { botId: string; initial: PayPalSettingsView }) {
  const t = useTranslations('bots.paypal');
  const tDyn = dynamicT(t);
  const url = `/api/bots/${encodeURIComponent(botId)}/paypal`;

  const [view, setView] = useState<PayPalSettingsView>(initial);
  const [busy, setBusy] = useState<Busy>(null);

  // ── connection ──
  const [conn, setConn] = useState(() => initialConnectionUi(initial.status));
  const dispatch = (event: ConnectionEvent) => setConn((c) => connectionUi(c, event));
  const [connStatus, setConnStatus] = useState<Status>(null);

  // ── webhook ──
  const [webhookStatus, setWebhookStatus] = useState<Status>(null);

  // ── limits ──
  const [draft, setDraft] = useState<LimitsDraft>(() => draftFromLimits(initial.limits));
  const [serverFieldErrors, setServerFieldErrors] = useState<Partial<Record<LimitField, string>>>({});
  const [limitsStatus, setLimitsStatus] = useState<Status>(null);

  // ── switches ──
  const [switchPending, setSwitchPending] = useState<Partial<Record<keyof PayPalSwitches, boolean>>>({});
  const [switchStatus, setSwitchStatus] = useState<Status>(null);

  const errorText = (key: PayPalSettingsErrorKey) => tDyn(`errors.${key}`);
  const own = hasOwnKeys(view);

  async function saveKeys() {
    const req = keysSaveRequest(conn);
    if (!req) return;
    setBusy('save');
    setConnStatus(null);
    setWebhookStatus(null);
    const r = await call(url, req);
    setBusy(null);
    if (!r.ok) {
      dispatch({ type: 'saveFailed' });
      setConnStatus({ kind: 'error', message: errorText(r.key) });
      return;
    }
    setView(r.view);
    dispatch({ type: 'saved' });
    setConnStatus({ kind: 'ok', message: t('connection.saved') });
  }

  async function disconnect() {
    const req = disconnectRequest(conn);
    if (!req) return;
    setBusy('disconnect');
    setConnStatus(null);
    const r = await call(url, req);
    setBusy(null);
    if (!r.ok) {
      dispatch({ type: 'disconnectFailed' });
      setConnStatus({ kind: 'error', message: errorText(r.key) });
      return;
    }
    setView(r.view);
    dispatch({ type: 'disconnected', status: r.view.status });
    setWebhookStatus(null);
    setConnStatus({ kind: 'ok', message: t('connection.disconnected') });
  }

  async function retryWebhook() {
    setBusy('webhook');
    setWebhookStatus(null);
    const r = await call(`${url}/webhook`, { method: 'POST' });
    setBusy(null);
    if (!r.ok) {
      setWebhookStatus({ kind: 'error', message: errorText(r.key) });
      return;
    }
    setView(r.view);
    if (!r.view.webhook.registered) {
      // The reason goes through the live region (announced), not as a second copy under "Not registered".
      const reason = webhookReasonKey(r.view.webhook.reason);
      setWebhookStatus({ kind: 'error', message: reason ? tDyn(`webhook.reasons.${reason}`) : t('webhook.notRegisteredHelp') });
    } else if (!r.view.webhook.reason) {
      setWebhookStatus({ kind: 'ok', message: t('webhook.retried') });
    }
  }

  // ── limits ──
  const parsed = parseLimitsDraft(draft);
  const limitsRequest = limitsSaveRequest(view.limits, draft);
  const dirty = !parsed.ok || limitsRequest !== null;

  function fieldError(field: LimitField): string | null {
    if (!parsed.ok && parsed.errors[field]) {
      const rule = LIMIT_RULES[field];
      if (parsed.errors[field] === 'invalid_value') return t(rule.money ? 'limits.errors.money' : 'limits.errors.whole');
      const fmt = (n: number) => (rule.money ? formatMoney(n, view.currency) : String(n));
      return t('limits.errors.range', { min: fmt(rule.min), max: fmt(rule.max) });
    }
    return serverFieldErrors[field] ?? null;
  }

  async function saveLimits() {
    if (!limitsRequest) return;
    setBusy('limits');
    setLimitsStatus(null);
    setServerFieldErrors({});
    const r = await call(url, limitsRequest);
    setBusy(null);
    if (!r.ok) {
      if (r.field && (LIMIT_FIELDS as readonly string[]).includes(r.field)) {
        setServerFieldErrors({ [r.field as LimitField]: errorText(r.key) });
      } else {
        setLimitsStatus({ kind: 'error', message: errorText(r.key) });
      }
      return;
    }
    const saved = r.view;
    setView((v) => afterLimitsSaved(v, saved).view);
    setDraft(draftFromLimits(saved.limits));
    setLimitsStatus({ kind: 'ok', message: t('limits.saved') });
  }

  // ── switches: optimistic, rolled back on error ──
  async function toggle(key: keyof PayPalSwitches) {
    const { next, request } = switchToggle(view, key);
    setSwitchStatus(null);
    setSwitchPending((p) => ({ ...p, [key]: true }));
    setView((v) => switchToggle(v, key).view);
    const r = await call(url, request);
    setSwitchPending((p) => ({ ...p, [key]: false }));
    if (!r.ok) {
      setView((v) => switchRollback(v, key, next));
      setSwitchStatus({ kind: 'error', message: errorText(r.key) });
      return;
    }
    const saved = r.view;
    setView((v) => switchSettle(v, key, saved));
  }

  const symbol = currencySymbol(view.currency);

  return (
    <div className="flex max-w-[720px] flex-col gap-6">
      {/* 1. Connection */}
      <Section title={t('connection.title')} badge={<EnvBadge env={view.env} />}>
        {view.botPaused && <Notice tone="warning">{t('connection.botPaused')}</Notice>}

        {view.status === 'failed' && (
          <Notice tone="error">
            {view.failedReason === 'invalid_credentials' ? t('connection.failedInvalid') : t('connection.failedOther')}
          </Notice>
        )}

        {view.status === 'demo_default' && <p className="text-sm leading-relaxed text-muted-foreground">{t('connection.demoDefault')}</p>}
        {view.status === 'not_connected' && <p className="text-sm leading-relaxed text-muted-foreground">{t('connection.notConnected')}</p>}

        {own && <SavedKeys view={view} />}

        {conn.formOpen ? (
          <KeysForm
            clientId={conn.clientId}
            secret={conn.secret}
            focusClientId={conn.focusClientId}
            busy={busy === 'save'}
            disabled={busy !== null}
            canSave={keysSaveRequest(conn) !== null}
            onClientId={(value) => dispatch({ type: 'input', field: 'clientId', value })}
            onSecret={(value) => dispatch({ type: 'input', field: 'secret', value })}
            onSave={saveKeys}
            onCancel={
              view.status === 'not_connected'
                ? undefined
                : () => {
                    dispatch({ type: 'closeForm' });
                    setConnStatus(null);
                  }
            }
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => {
                setConnStatus(null);
                dispatch({ type: 'openForm' });
              }}
            >
              {own ? t('connection.replace') : t('connection.useOwn')}
            </Button>
            {own &&
              (conn.confirmDisconnect ? (
                <>
                  <Button variant="destructive" size="sm" disabled={busy !== null} onClick={disconnect}>
                    {busy === 'disconnect' ? <Loader2 className="animate-spin" /> : t('connection.confirmDisconnect')}
                  </Button>
                  {/* Focus lands on the safe choice: Enter right after "Disconnect" does not disconnect. */}
                  <Button variant="ghost" size="sm" autoFocus disabled={busy !== null} onClick={() => dispatch({ type: 'cancelDisconnect' })}>
                    {t('cancel')}
                  </Button>
                  <span className="basis-full text-xs text-muted-foreground">{t('connection.disconnectNote')}</span>
                </>
              ) : (
                <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => dispatch({ type: 'askDisconnect' })}>
                  {t('connection.disconnect')}
                </Button>
              ))}
          </div>
        )}

        <StatusLine status={connStatus} />
      </Section>

      {/* 2. Webhook — only for the bot's own keys (the demo bot's shared webhook is managed by a script). */}
      {own && (
        <Section title={t('webhook.title')}>
          <p className="text-sm leading-relaxed text-muted-foreground">{t('webhook.intro')}</p>
          <WebhookState view={view} showReason={webhookStatus === null} />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={retryWebhook}>
              {busy === 'webhook' ? <Loader2 className="animate-spin" /> : view.webhook.registered ? t('webhook.checkAgain') : t('webhook.retry')}
            </Button>
          </div>
          <StatusLine status={webhookStatus} />
        </Section>
      )}

      {/* 3. Refund limits — the guardrail RPC reads these at refund time. Editable with or without keys. */}
      <Section title={t('limits.title')}>
        <p className="text-sm leading-relaxed text-muted-foreground">{t('limits.intro')}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {LIMIT_FIELDS.map((field) => (
            <LimitInput
              key={field}
              field={field}
              symbol={LIMIT_RULES[field].money ? symbol : null}
              value={draft[field]}
              error={fieldError(field)}
              disabled={busy === 'limits'}
              onChange={(value) => {
                setLimitsStatus(null);
                setServerFieldErrors((e) => ({ ...e, [field]: undefined }));
                setDraft((d) => ({ ...d, [field]: value }));
              }}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy !== null || !limitsRequest} onClick={saveLimits}>
            {busy === 'limits' ? <Loader2 className="animate-spin" /> : t('limits.save')}
          </Button>
          {dirty && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() => {
                setDraft(draftFromLimits(view.limits));
                setServerFieldErrors({});
                setLimitsStatus(null);
              }}
            >
              {t('cancel')}
            </Button>
          )}
        </div>
        <StatusLine status={limitsStatus} />
      </Section>

      {/* 4. Switches — saved on toggle. */}
      <Section title={t('switches.title')}>
        <div className="flex flex-col divide-y divide-border">
          {(['paused', 'proposeOnly'] as const).map((key) => (
            <SwitchRow
              key={key}
              id={`paypal-switch-${key}`}
              label={t(`switches.${key}.label`)}
              help={t(`switches.${key}.help`)}
              on={view.switches[key]}
              disabled={Boolean(switchPending[key])}
              onToggle={() => toggle(key)}
            />
          ))}
        </div>
        <StatusLine status={switchStatus} />
      </Section>
    </div>
  );
}

// ── pieces ──────────────────────────────────────────

function Section({ title, badge, children }: { title: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="card-surface flex flex-col gap-4 p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-bold tracking-[-0.01em]">{title}</h2>
        {badge}
      </div>
      {children}
    </section>
  );
}

function EnvBadge({ env }: { env: 'sandbox' | 'live' }) {
  const t = useTranslations('bots.paypal');
  return (
    <span className="rounded-full border border-border-strong px-2 py-0.5 text-[11.5px] font-semibold text-muted-foreground">
      {env === 'live' ? t('env.live') : t('env.sandbox')}
    </span>
  );
}

function Notice({ tone, children }: { tone: 'warning' | 'error'; children: React.ReactNode }) {
  return (
    <div className={cn('flex items-start gap-2.5 border-l-2 pl-3', tone === 'error' ? 'border-destructive' : 'border-amber-600')}>
      <AlertTriangle className={cn('mt-0.5 h-4 w-4 shrink-0', tone === 'error' ? 'text-destructive' : 'text-amber-600')} aria-hidden />
      <p className={cn('text-sm', tone === 'error' ? 'font-semibold text-destructive' : 'text-foreground')}>{children}</p>
    </div>
  );
}

/** Always in the DOM (empty when there is nothing to say) so screen readers announce each new message. Not display:none when empty — a hidden live region is not reliably announced; the negative margin only cancels the card gap. */
function StatusLine({ status }: { status: Status }) {
  return (
    <p aria-live="polite" className={cn('text-xs empty:-mt-4', status?.kind === 'ok' ? 'text-brand-strong' : 'text-destructive')}>
      {status?.message ?? ''}
    </p>
  );
}

function SavedKeys({ view }: { view: PayPalSettingsView }) {
  const t = useTranslations('bots.paypal.connection');
  const format = useFormatter();
  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
      <dt className="text-muted-foreground">{t('status')}</dt>
      <dd className={cn('font-semibold', view.status === 'failed' ? 'text-destructive' : 'text-brand-strong')}>
        {view.status === 'failed' ? t('statusFailed') : t('statusConnected')}
      </dd>

      <dt className="text-muted-foreground">{t('clientId')}</dt>
      <dd className="break-all font-mono text-[12.5px]">{view.clientId}</dd>

      <dt className="text-muted-foreground">{t('secret')}</dt>
      <dd className="font-mono text-[12.5px] tabular-nums">{view.secretLast4 ? `••••${view.secretLast4}` : t('secretStored')}</dd>

      {view.verifiedAt && (
        <>
          <dt className="text-muted-foreground">{t('verifiedAt')}</dt>
          <dd className="tabular-nums text-muted-foreground">
            {format.dateTime(new Date(view.verifiedAt), { dateStyle: 'medium', timeStyle: 'short' })}
          </dd>
        </>
      )}
    </dl>
  );
}

function KeysForm({
  clientId,
  secret,
  focusClientId,
  busy,
  disabled,
  canSave,
  onClientId,
  onSecret,
  onSave,
  onCancel,
}: {
  clientId: string;
  secret: string;
  /** Opened by "Replace keys" / "Use my own keys" — not on page load. */
  focusClientId: boolean;
  busy: boolean;
  disabled: boolean;
  canSave: boolean;
  onClientId: (v: string) => void;
  onSecret: (v: string) => void;
  onSave: () => void;
  onCancel?: () => void;
}) {
  const t = useTranslations('bots.paypal.connection');
  const tp = useTranslations('bots.paypal');
  return (
    <form
      className="flex flex-col gap-4 border-t border-border pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled && canSave) onSave();
      }}
    >
      <p className="text-sm leading-relaxed text-muted-foreground">
        {t.rich('help', {
          link: (chunks) => (
            <a href={PAYPAL_DEV_APPS_URL} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-strong underline-offset-4 hover:underline">
              {chunks}
            </a>
          ),
        })}
      </p>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-semibold text-muted-foreground">{t('clientId')}</span>
        <Input value={clientId} onChange={(e) => onClientId(e.target.value)} disabled={disabled} autoFocus={focusClientId} autoComplete="off" spellCheck={false} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-semibold text-muted-foreground">{t('secret')}</span>
        {/* Not a login password: keep browser and password-manager autofill out of it. */}
        <Input
          type="password"
          value={secret}
          onChange={(e) => onSecret(e.target.value)}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={disabled || !canSave}>
          {busy ? (
            <>
              <Loader2 className="animate-spin" /> {t('checking')}
            </>
          ) : (
            t('save')
          )}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onCancel}>
            {tp('cancel')}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t('sandboxNote')}</p>
    </form>
  );
}

/** `showReason` false while the live region below already says why (a Retry just failed) — one copy, not two. */
function WebhookState({ view, showReason }: { view: PayPalSettingsView; showReason: boolean }) {
  const t = useTranslations('bots.paypal.webhook');
  const tDyn = dynamicT(t);
  const reason = webhookReasonKey(view.webhook.reason);
  const reasonText = reason ? tDyn(`reasons.${reason}`) : null;

  if (view.webhook.registered) {
    return (
      <div className="flex flex-col gap-1.5 text-sm">
        <p>
          <span className="font-semibold text-brand-strong">{t('registered')}</span>
          <span className="ml-2 break-all font-mono text-[12.5px] text-muted-foreground">{view.webhook.id}</span>
        </p>
        {/* A stored id kept without asking PayPal (http origin) — registered, but not re-checked this time. */}
        {reasonText && <p className="text-xs text-muted-foreground">{t('keptNote', { reason: reasonText })}</p>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <p className="font-semibold text-destructive">{t('notRegistered')}</p>
      {showReason && <p className="text-xs text-muted-foreground">{reasonText ?? t('notRegisteredHelp')}</p>}
    </div>
  );
}

function LimitInput({
  field,
  symbol,
  value,
  error,
  disabled,
  onChange,
}: {
  field: LimitField;
  symbol: string | null;
  value: string;
  error: string | null;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const t = useTranslations('bots.paypal.limits.fields');
  const id = `paypal-limit-${field}`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[12.5px] font-semibold text-muted-foreground">
        {t(`${field}.label`)}
      </label>
      <div className="flex items-center gap-2">
        {symbol && <span className="text-sm font-semibold text-muted-foreground">{symbol}</span>}
        <Input
          id={id}
          inputMode={symbol ? 'decimal' : 'numeric'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint`}
          className="max-w-[9rem] tabular-nums"
        />
        <span className="text-[12.5px] text-muted-foreground">{t(`${field}.unit`)}</span>
      </div>
      <p id={`${id}-hint`} className={cn('text-xs', error ? 'text-destructive' : 'text-faint')}>
        {error ?? t(`${field}.hint`)}
      </p>
    </div>
  );
}

function SwitchRow({
  id,
  label,
  help,
  on,
  disabled,
  onToggle,
}: {
  id: string;
  label: string;
  help: string;
  on: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p id={`${id}-label`} className="text-sm font-semibold">
          {label}
        </p>
        <p id={`${id}-help`} className="mt-0.5 text-[12.5px] leading-[1.45] text-muted-foreground">
          {help}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-help`}
        disabled={disabled}
        onClick={onToggle}
        className={cn(
          'relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-60',
          on ? 'bg-primary' : 'bg-border-strong',
        )}
      >
        <span
          aria-hidden
          className={cn('inline-block h-5 w-5 rounded-full bg-background shadow transition-transform', on ? 'translate-x-[22px]' : 'translate-x-0.5')}
        />
      </button>
    </div>
  );
}
