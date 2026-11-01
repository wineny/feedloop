import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  LIMIT_FIELDS,
  LIMIT_RULES,
  PAYPAL_SETTINGS_ERROR_CODES,
  PAYPAL_SETTINGS_EXTRA_ERROR_KEYS,
  PAYPAL_WEBHOOK_REASONS,
  afterLimitsSaved,
  centsToDollarInput,
  connectionUi,
  disconnectRequest,
  initialConnectionUi,
  keysSaveRequest,
  limitsSaveRequest,
  switchRollback,
  switchSettle,
  switchToggle,
  changedLimits,
  currencySymbol,
  dollarInputToCents,
  draftFromLimits,
  parseLimitsDraft,
  settingsErrorKey,
  webhookReasonKey,
  type PayPalSettingsView,
} from '@/lib/paypal/settings-form';
import { PayPalSettingsPanel } from '@/components/bots/PayPalSettingsPanel';
import { loadMessages, renderWithIntl } from './helpers/intl';

// settings.ts is imported only for parseLimitsPatch / presentPayPalSettings (pure); keep its server deps inert.
vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: () => ({}) }));
vi.mock('@/lib/utils/crypto', () => ({ encrypt: vi.fn(), decrypt: vi.fn() }));
const { parseLimitsPatch, presentPayPalSettings } = await import('@/lib/paypal/settings');

beforeAll(() => vi.stubGlobal('React', React));
afterAll(() => vi.unstubAllGlobals());

const LIMITS = { refundAutoMaxCents: 2500, refundAutoDays: 30, refundDailyCapCents: 20000, refundPerCustomer30d: 2 };

describe('dollars ↔ cents', () => {
  it('cents → what the dollar input shows', () => {
    expect(centsToDollarInput(2500)).toBe('25');
    expect(centsToDollarInput(2550)).toBe('25.50');
    expect(centsToDollarInput(5)).toBe('0.05');
    expect(centsToDollarInput(0)).toBe('0');
    expect(centsToDollarInput(100_000_000)).toBe('1000000');
  });

  it('typed dollars → cents, integer math', () => {
    expect(dollarInputToCents('25')).toBe(2500);
    expect(dollarInputToCents(' 25.5 ')).toBe(2550);
    expect(dollarInputToCents('0.29')).toBe(29);
    expect(dollarInputToCents('1,000')).toBe(100000);
    expect(dollarInputToCents('12,345.50')).toBe(1234550);
    expect(dollarInputToCents('19.99')).toBe(1999);
  });

  it('anything not an amount → null', () => {
    for (const bad of ['', '-1', '1.234', 'abc', '$5', '1e3', '.5', '1,0', '10,00', ',100', '1,000,', '1,,000', '1000,000']) {
      expect(dollarInputToCents(bad), bad).toBeNull();
    }
  });

  it('round trip', () => {
    for (const cents of [0, 1, 99, 100, 2550, 123456]) expect(dollarInputToCents(centsToDollarInput(cents))).toBe(cents);
  });

  it('currency symbol from the bot currency', () => {
    expect(currencySymbol('USD')).toBe('$');
    expect(currencySymbol('EUR')).toBe('€');
    expect(currencySymbol('nope')).toBe('nope');
  });
});

describe('limits draft → PATCH body', () => {
  it('a draft built from saved limits parses back to the same values and changes nothing', () => {
    const parsed = parseLimitsDraft(draftFromLimits(LIMITS));
    expect(parsed).toEqual({ ok: true, limits: LIMITS });
    if (parsed.ok) expect(changedLimits(LIMITS, parsed.limits)).toEqual({});
  });

  it('only changed fields are sent', () => {
    const draft = { ...draftFromLimits(LIMITS), refundAutoMaxCents: '40', refundPerCustomer30d: '3' };
    const parsed = parseLimitsDraft(draft);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(changedLimits(LIMITS, parsed.limits)).toEqual({ refundAutoMaxCents: 4000, refundPerCustomer30d: 3 });
  });

  it('per-field errors: not a number vs out of range', () => {
    const parsed = parseLimitsDraft({ refundAutoMaxCents: 'abc', refundAutoDays: '181', refundDailyCapCents: '10', refundPerCustomer30d: '1.5' });
    expect(parsed).toEqual({ ok: false, errors: { refundAutoMaxCents: 'invalid_value', refundAutoDays: 'out_of_range', refundPerCustomer30d: 'invalid_value' } });
    expect(parseLimitsDraft({ ...draftFromLimits(LIMITS), refundAutoMaxCents: '1000000.01' })).toEqual({
      ok: false,
      errors: { refundAutoMaxCents: 'out_of_range' },
    });
  });

  it('client ranges match the API (parseLimitsPatch) at both edges', () => {
    for (const field of LIMIT_FIELDS) {
      const { min, max } = LIMIT_RULES[field];
      expect(parseLimitsPatch({ [field]: min }).ok, `${field} min`).toBe(true);
      expect(parseLimitsPatch({ [field]: max }).ok, `${field} max`).toBe(true);
      expect(parseLimitsPatch({ [field]: max + 1 }), `${field} max+1`).toMatchObject({ ok: false, code: 'out_of_range' });
      expect(parseLimitsPatch({ [field]: min - 1 }), `${field} min-1`).toMatchObject({ ok: false, code: 'out_of_range' });
    }
  });
});

describe('error codes → messages', () => {
  const routeFiles = ['src/app/api/bots/[id]/paypal/route.ts', 'src/app/api/bots/[id]/paypal/webhook/route.ts'];

  it('every literal error code the routes answer is mapped', () => {
    const codes = new Set<string>();
    for (const file of routeFiles) {
      const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
      for (const m of src.matchAll(/error:\s*'([a-z_]+)'/g)) codes.add(m[1]);
    }
    expect(codes.size).toBeGreaterThan(5);
    expect([...codes].filter((c) => !PAYPAL_SETTINGS_ERROR_CODES.includes(c as never))).toEqual([]);
  });

  it('every code (and auth/network/fallback key) has a message in en and ko', () => {
    for (const locale of ['en', 'ko'] as const) {
      const errors = (loadMessages(locale).bots as { paypal: { errors: Record<string, string> } }).paypal.errors;
      const missing = [...PAYPAL_SETTINGS_ERROR_CODES, ...PAYPAL_SETTINGS_EXTRA_ERROR_KEYS].filter((k) => !errors[k]);
      expect(missing, locale).toEqual([]);
    }
  });

  it('auth answers go by status (their error is free text); unknown codes get the generic message', () => {
    expect(settingsErrorKey(401, 'Unauthorized')).toBe('unauthorized');
    expect(settingsErrorKey(403, 'Some translated text')).toBe('forbidden');
    expect(settingsErrorKey(400, 'invalid_credentials')).toBe('invalid_credentials');
    expect(settingsErrorKey(429, 'too_many_checks')).toBe('too_many_checks');
    expect(settingsErrorKey(500, 'something_new')).toBe('unknown');
    expect(settingsErrorKey(500, undefined)).toBe('unknown');
    expect(settingsErrorKey(400, 'toString')).toBe('unknown');
  });

  it('every webhook reason has a message in en and ko', () => {
    for (const locale of ['en', 'ko'] as const) {
      const reasons = (loadMessages(locale).bots as { paypal: { webhook: { reasons: Record<string, string> } } }).paypal.webhook.reasons;
      expect(PAYPAL_WEBHOOK_REASONS.filter((r) => !reasons[r]), locale).toEqual([]);
    }
  });

  it('webhook reason mapping', () => {
    expect(webhookReasonKey('https_required')).toBe('https_required');
    expect(webhookReasonKey('webhook_limit_reached')).toBe('webhook_limit_reached');
    expect(webhookReasonKey(undefined)).toBeNull();
    expect(webhookReasonKey('constructor')).toBeNull();
  });
});

// ── screen ──

const ROW = {
  id: 'bot-1',
  status: 'active',
  is_demo: false,
  paypal_client_id: null,
  paypal_secret_encrypted: null,
  paypal_secret_last4: null,
  paypal_env: 'sandbox',
  paypal_verified_at: null,
  paypal_failed_at: null,
  paypal_failed_reason: null,
  paypal_scopes: null,
  paypal_webhook_id: null,
  paypal_paused: false,
  propose_only: false,
  refund_auto_max_cents: 2500,
  refund_auto_days: 30,
  refund_daily_cap_cents: 20000,
  refund_per_customer_30d: 2,
  currency: 'USD',
};
const CONNECTED_ROW = {
  ...ROW,
  paypal_client_id: 'AaBbCcDdEeFfGgHh0123456789clientid',
  paypal_secret_encrypted: 'cipher',
  paypal_secret_last4: 'wxyz',
  paypal_verified_at: '2026-10-22T10:00:00.000Z',
  paypal_webhook_id: 'WH-123',
};

const render = (view: PayPalSettingsView, locale: 'en' | 'ko' = 'en') =>
  renderWithIntl(React.createElement(PayPalSettingsPanel, { botId: 'bot-1', initial: view }), locale);

describe('PayPalSettingsPanel render', () => {
  it('not connected: key form with sandbox badge and developer link, no webhook section', () => {
    const html = render(presentPayPalSettings(ROW));
    expect(html).toContain('isn&#x27;t connected to PayPal');
    expect(html).toContain('Client ID');
    expect(html).toContain('type="password"');
    expect(html).toContain('Sandbox');
    expect(html).toContain('href="https://developer.paypal.com/dashboard/applications/sandbox"');
    expect(html).toContain('Check and save');
    expect(html).not.toContain('Webhook');
    // limits and switches are there even without keys (the API allows them)
    expect(html).toContain('Refund limits');
    expect(html).toContain('value="25"');
    expect(html).toContain('value="200"');
    expect(html).toContain('Pause automatic refunds');
    expect(html).toContain('Ask me before every refund');
  });

  it('connected: client id, masked secret, replace/disconnect, webhook registered, never the secret', () => {
    const html = render(presentPayPalSettings(CONNECTED_ROW));
    expect(html).toContain('AaBbCcDdEeFfGgHh0123456789clientid');
    expect(html).toContain('••••wxyz');
    expect(html).not.toContain('cipher');
    expect(html).not.toContain('type="password"');
    expect(html).toContain('Replace keys');
    expect(html).toContain('Disconnect');
    expect(html).toContain('Registered');
    expect(html).toContain('WH-123');
    expect(html).toContain('Check again');
    expect(html).not.toContain('>Retry<');
  });

  it('connected without a webhook: not registered + generic help; a reason from a save shows its text', () => {
    const view = presentPayPalSettings({ ...CONNECTED_ROW, paypal_webhook_id: null });
    expect(render(view)).toContain('Not registered');
    expect(render(view)).toContain('>Retry<');
    const withReason: PayPalSettingsView = { ...view, webhook: { registered: false, reason: 'https_required' } };
    expect(render(withReason)).toContain('PayPal only sends events to https addresses. Deploy first, then press Retry.');
  });

  it('registered + reason (stored id kept on an http origin) → registered with a small note', () => {
    const view: PayPalSettingsView = {
      ...presentPayPalSettings(CONNECTED_ROW),
      webhook: { registered: true, id: 'WH-123', reason: 'https_required' },
    };
    const html = render(view);
    expect(html).toContain('Registered');
    expect(html).toContain('Couldn&#x27;t re-check the webhook, so the saved one stays.');
    expect(html).not.toContain('Not registered');
  });

  it('failed: warning and the key form open', () => {
    const html = render(
      presentPayPalSettings({ ...CONNECTED_ROW, paypal_failed_at: '2026-10-22T11:00:00.000Z', paypal_failed_reason: 'invalid_credentials' }),
    );
    expect(html).toContain('PayPal no longer accepts the saved keys');
    expect(html).toContain('type="password"');
  });

  it('demo bot on the shared account: explanation + "Use my own keys", no webhook section', () => {
    const html = render(presentPayPalSettings({ ...ROW, is_demo: true }));
    expect(html).toContain('This demo bot uses the shared sandbox account.');
    expect(html).toContain('Use my own keys');
    expect(html).not.toContain('Webhook');
  });

  it('paused bot: explains why PayPal is off', () => {
    expect(render(presentPayPalSettings({ ...CONNECTED_ROW, status: 'paused' }))).toContain('This bot is paused');
  });

  it('Secret input keeps password managers out; badge follows view.env; status lines are persistent live regions', () => {
    const html = render(presentPayPalSettings(ROW));
    expect(html).toMatch(/type="password"[^>]*autoComplete="off"|type="password"[^>]*autocomplete="off"/);
    expect(html).toContain('data-1p-ignore');
    expect(html).toContain('data-lpignore="true"');
    expect(html.match(/aria-live="polite"/g)?.length).toBe(3); // connection, limits, switches (no webhook without keys)
    expect(render({ ...presentPayPalSettings(CONNECTED_ROW), env: 'live' })).toContain('>Live<');
  });

  it('switch state comes from the view', () => {
    const html = render(presentPayPalSettings({ ...ROW, paypal_paused: true }));
    expect(html).toMatch(/role="switch" aria-checked="true" aria-labelledby="paypal-switch-paused-label"/);
    expect(html).toMatch(/role="switch" aria-checked="false" aria-labelledby="paypal-switch-proposeOnly-label"/);
  });

  it('ko renders', () => {
    const html = render(presentPayPalSettings(CONNECTED_ROW), 'ko');
    expect(html).toContain('환불 한도');
    expect(html).toContain('키 바꾸기');
  });
});

// ── state transitions (the panel only wires these to fetch/useState) ──

const VIEW = presentPayPalSettings(ROW) as PayPalSettingsView;

describe('switches: optimistic toggle, rollback, settle', () => {
  it('toggle flips the one switch at once and sends only that field', () => {
    const r = switchToggle(VIEW, 'paused');
    expect(r.next).toBe(true);
    expect(r.view.switches).toEqual({ paused: true, proposeOnly: false });
    expect(r.request).toEqual({ method: 'PATCH', body: { paused: true } });
    expect(VIEW.switches.paused).toBe(false); // input not mutated
  });

  it('rollback puts that switch back and keeps anything else that changed meanwhile', () => {
    const optimistic = switchToggle(VIEW, 'proposeOnly').view;
    const meanwhile = { ...optimistic, limits: { ...optimistic.limits, refundAutoDays: 7 } };
    const back = switchRollback(meanwhile, 'proposeOnly', true);
    expect(back.switches.proposeOnly).toBe(false);
    expect(back.limits.refundAutoDays).toBe(7);
  });

  it('settle takes only that switch from the server answer', () => {
    const local = { ...switchToggle(VIEW, 'paused').view, switches: { paused: true, proposeOnly: true } };
    const server = { ...VIEW, switches: { paused: true, proposeOnly: false }, limits: { ...VIEW.limits, refundAutoDays: 99 } };
    const settled = switchSettle(local, 'paused', server);
    expect(settled.switches).toEqual({ paused: true, proposeOnly: true }); // the other switch's own request is not undone
    expect(settled.limits).toEqual(VIEW.limits);
  });
});

describe('limits: PATCH body and what a save keeps', () => {
  it('changed fields only; null when unchanged or invalid', () => {
    const draft = draftFromLimits(VIEW.limits);
    expect(limitsSaveRequest(VIEW.limits, draft)).toBeNull();
    expect(limitsSaveRequest(VIEW.limits, { ...draft, refundAutoDays: 'x' })).toBeNull();
    expect(limitsSaveRequest(VIEW.limits, { ...draft, refundDailyCapCents: '150.25' })).toEqual({
      method: 'PATCH',
      body: { refundDailyCapCents: 15025 },
    });
  });

  it('a saved answer replaces only the limits (and the draft), never the switches', () => {
    const local = { ...VIEW, switches: { paused: true, proposeOnly: false } }; // optimistic toggle in flight
    const server = { ...VIEW, limits: { ...VIEW.limits, refundAutoDays: 14 }, switches: { paused: false, proposeOnly: false } };
    const after = afterLimitsSaved(local, server);
    expect(after.view.limits.refundAutoDays).toBe(14);
    expect(after.view.switches).toEqual({ paused: true, proposeOnly: false });
    expect(after.draft.refundAutoDays).toBe('14');
  });
});

describe('connection card: key form and disconnect confirm', () => {
  const typed = (status: 'not_connected' | 'connected' = 'not_connected') =>
    [
      { type: 'input', field: 'clientId', value: ' AaBbCcDdEeFfGgHh0123 ' },
      { type: 'input', field: 'secret', value: 'SecretSecretSecret99\n' },
    ].reduce((s, e) => connectionUi(s, e as never), initialConnectionUi(status));

  it('form is open from the start only when there are no working keys; no focus grab on load', () => {
    expect(initialConnectionUi('not_connected')).toMatchObject({ formOpen: true, focusClientId: false });
    expect(initialConnectionUi('failed').formOpen).toBe(true);
    expect(initialConnectionUi('connected').formOpen).toBe(false);
    expect(initialConnectionUi('demo_default').formOpen).toBe(false);
  });

  it('Replace keys opens an empty form and focuses Client ID', () => {
    const s = connectionUi({ ...initialConnectionUi('connected'), confirmDisconnect: true }, { type: 'openForm' });
    expect(s).toEqual({ formOpen: true, focusClientId: true, clientId: '', secret: '', confirmDisconnect: false });
  });

  it('PUT body is trimmed; nothing to send while a field is empty', () => {
    expect(keysSaveRequest(initialConnectionUi('not_connected'))).toBeNull();
    expect(keysSaveRequest(connectionUi(initialConnectionUi('not_connected'), { type: 'input', field: 'clientId', value: 'abc' }))).toBeNull();
    expect(keysSaveRequest(typed())).toEqual({ method: 'PUT', body: { clientId: 'AaBbCcDdEeFfGgHh0123', secret: 'SecretSecretSecret99' } });
  });

  it('a successful save clears the secret (and id) and closes the form; a failed one keeps the input', () => {
    const saved = connectionUi(typed(), { type: 'saved' });
    expect(saved).toMatchObject({ formOpen: false, clientId: '', secret: '' });
    const failed = connectionUi(typed(), { type: 'saveFailed' });
    expect(failed.secret).not.toBe('');
    expect(failed.formOpen).toBe(true);
  });

  it('Disconnect asks first; DELETE only from the confirm; the result closes the confirm', () => {
    const start = initialConnectionUi('connected');
    expect(disconnectRequest(start)).toBeNull();
    const asking = connectionUi(start, { type: 'askDisconnect' });
    expect(disconnectRequest(asking)).toEqual({ method: 'DELETE' });
    expect(disconnectRequest(connectionUi(asking, { type: 'cancelDisconnect' }))).toBeNull();
    expect(connectionUi(asking, { type: 'disconnectFailed' }).confirmDisconnect).toBe(false);
    expect(connectionUi(asking, { type: 'disconnected', status: 'not_connected' })).toMatchObject({ confirmDisconnect: false, formOpen: true });
    // A demo bot falls back to the shared account: no form forced open.
    expect(connectionUi(asking, { type: 'disconnected', status: 'demo_default' }).formOpen).toBe(false);
  });
});
