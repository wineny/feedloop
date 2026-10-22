// Bot settings › PayPal tab — pure helpers the screen (`components/bots/PayPalSettingsPanel`) and tests share.
//
// No server imports: this ships to the browser. Types come from `settings.ts` as `import type` only
// (erased at build), so the screen and the API cannot drift on field names or error codes.

import type {
  CredentialsParse,
  LimitsParse,
  PayPalConnectionStatus,
  VerifyResult,
  WebhookFailReason,
} from './settings';
import { centsToValue, valueToCents } from './money';

// ── the API's view (presentPayPalSettings / presentWithWebhook) ──

export interface PayPalLimits {
  refundAutoMaxCents: number;
  refundAutoDays: number;
  refundDailyCapCents: number;
  refundPerCustomer30d: number;
}

export interface PayPalSwitches {
  paused: boolean;
  proposeOnly: boolean;
}

/**
 * `registered: true` can carry a `reason` too: a same-app re-save from an http origin keeps the stored
 * id without asking PayPal. GET never has a reason — only the answer to a save or a retry does.
 */
export type PayPalWebhookView =
  | { registered: true; id: string; reason?: WebhookFailReason }
  | { registered: false; reason?: WebhookFailReason };

export interface PayPalSettingsView {
  status: PayPalConnectionStatus;
  botPaused: boolean;
  clientId: string | null;
  secretLast4: string | null;
  env: 'sandbox' | 'live';
  verifiedAt: string | null;
  failedAt: string | null;
  failedReason: string | null;
  scopes: string[];
  webhook: PayPalWebhookView;
  limits: PayPalLimits;
  switches: PayPalSwitches;
  currency: string;
}

/** The bot has its own saved keys (connected, or saved but rejected later). Only then is there a webhook to manage. */
export function hasOwnKeys(view: Pick<PayPalSettingsView, 'status'>): boolean {
  return view.status === 'connected' || view.status === 'failed';
}

// ── error codes → message keys (`bots.paypal.errors.<key>`) ──

type ParseCode = Extract<CredentialsParse, { ok: false }>['code'] | Extract<LimitsParse, { ok: false }>['code'];
type VerifyCode = Extract<VerifyResult, { ok: false }>['code'];
/** Codes the routes write themselves (`api/bots/[id]/paypal/route.ts`, `.../paypal/webhook/route.ts`). */
type RouteCode = 'bad_request' | 'server_error' | 'bot_not_found' | 'too_many_checks' | 'save_failed' | 'not_connected' | 'secret_unreadable';
export type PayPalSettingsErrorCode = ParseCode | VerifyCode | RouteCode;

/** Every `{ error: <code> }` the PayPal settings routes can answer. A `Record` so a new code fails tsc until it is listed. */
const ERROR_CODES: Record<PayPalSettingsErrorCode, true> = {
  unknown_field: true,
  client_id_invalid: true,
  secret_invalid: true,
  live_not_allowed: true,
  env_invalid: true,
  invalid_value: true,
  out_of_range: true,
  nothing_to_change: true,
  invalid_credentials: true,
  paypal_unreachable: true,
  bad_request: true,
  server_error: true,
  bot_not_found: true,
  too_many_checks: true,
  save_failed: true,
  not_connected: true,
  secret_unreadable: true,
};
export const PAYPAL_SETTINGS_ERROR_CODES = Object.keys(ERROR_CODES) as PayPalSettingsErrorCode[];

/** Keys under `bots.paypal.errors` that are not API codes: auth answers (their `error` is free text), network, fallback. */
export const PAYPAL_SETTINGS_EXTRA_ERROR_KEYS = ['unauthorized', 'forbidden', 'network', 'unknown'] as const;
export type PayPalSettingsErrorKey = PayPalSettingsErrorCode | (typeof PAYPAL_SETTINGS_EXTRA_ERROR_KEYS)[number];

/**
 * Which message to show for a failed response. 401/403 come from `resolveOwnedBots`, whose `error` is
 * text rather than a code, so they go by status. An unknown code gets the generic message, never the raw code.
 */
export function settingsErrorKey(status: number, code: unknown): PayPalSettingsErrorKey {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (typeof code === 'string' && Object.hasOwn(ERROR_CODES, code)) return code as PayPalSettingsErrorCode;
  return 'unknown';
}

// ── webhook reasons → message keys (`bots.paypal.webhook.reasons.<reason>`) ──

const WEBHOOK_REASONS: Record<WebhookFailReason, true> = {
  no_base_url: true,
  https_required: true,
  invalid_credentials: true,
  webhook_limit_reached: true,
  paypal_unreachable: true,
  paypal_error: true,
};
export const PAYPAL_WEBHOOK_REASONS = Object.keys(WEBHOOK_REASONS) as WebhookFailReason[];

/** null for a missing or unknown reason (the screen then shows its generic "not registered" line). */
export function webhookReasonKey(reason: unknown): WebhookFailReason | null {
  return typeof reason === 'string' && Object.hasOwn(WEBHOOK_REASONS, reason) ? (reason as WebhookFailReason) : null;
}

// ── refund limits form ──

export type LimitField = keyof PayPalLimits;
export const LIMIT_FIELDS: readonly LimitField[] = ['refundAutoMaxCents', 'refundAutoDays', 'refundDailyCapCents', 'refundPerCustomer30d'];

/**
 * Same ranges as `parseLimitsPatch` (settings.ts) — a test holds them together. `money` fields are
 * typed in dollars and sent in cents.
 */
export const LIMIT_RULES: Record<LimitField, { min: number; max: number; money: boolean }> = {
  refundAutoMaxCents: { min: 0, max: 100_000_000, money: true },
  refundAutoDays: { min: 0, max: 180, money: false },
  refundDailyCapCents: { min: 0, max: 100_000_000, money: true },
  refundPerCustomer30d: { min: 0, max: 100, money: false },
};

export type LimitsDraft = Record<LimitField, string>;

/** 2500 → "25", 2550 → "25.50". What the dollar input shows. */
export function centsToDollarInput(cents: number): string {
  const value = centsToValue(cents);
  return value.endsWith('.00') ? value.slice(0, -3) : value;
}

// Commas only as standard thousands separators ("1,000", "12,345.50"); "1,0" or "10,00" is rejected, not guessed.
const THOUSANDS_RE = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/;

/** "25" / "25.5" / "1,000" → cents; null for anything else (negative, 3 decimals, letters, odd commas). */
export function dollarInputToCents(input: string): number | null {
  const v = input.trim();
  if (v.includes(',')) return THOUSANDS_RE.test(v) ? valueToCents(v.replace(/,/g, '')) : null;
  return valueToCents(v);
}

export function draftFromLimits(limits: PayPalLimits): LimitsDraft {
  return {
    refundAutoMaxCents: centsToDollarInput(limits.refundAutoMaxCents),
    refundAutoDays: String(limits.refundAutoDays),
    refundDailyCapCents: centsToDollarInput(limits.refundDailyCapCents),
    refundPerCustomer30d: String(limits.refundPerCustomer30d),
  };
}

export type LimitFieldError = 'invalid_value' | 'out_of_range';

export type LimitsDraftParse =
  | { ok: true; limits: PayPalLimits }
  | { ok: false; errors: Partial<Record<LimitField, LimitFieldError>> };

export function parseLimitsDraft(draft: LimitsDraft): LimitsDraftParse {
  const limits = {} as PayPalLimits;
  const errors: Partial<Record<LimitField, LimitFieldError>> = {};
  for (const field of LIMIT_FIELDS) {
    const rule = LIMIT_RULES[field];
    const raw = draft[field].trim();
    const value = rule.money ? dollarInputToCents(raw) : /^\d+$/.test(raw) ? Number(raw) : null;
    if (value === null) errors[field] = 'invalid_value';
    else if (value < rule.min || value > rule.max) errors[field] = 'out_of_range';
    else limits[field] = value;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, limits };
}

/** Only the fields that differ from what is saved — the PATCH body. Empty object = nothing to send. */
export function changedLimits(saved: PayPalLimits, next: PayPalLimits): Partial<PayPalLimits> {
  const out: Partial<PayPalLimits> = {};
  for (const field of LIMIT_FIELDS) {
    if (saved[field] !== next[field]) out[field] = next[field];
  }
  return out;
}

/** "USD" → "$". Falls back to the code for a currency Intl does not know. */
export function currencySymbol(currency: string): string {
  try {
    const part = new Intl.NumberFormat('en-US', { style: 'currency', currency }).formatToParts(0).find((p) => p.type === 'currency');
    return part?.value ?? currency;
  } catch {
    return currency;
  }
}

// ── screen state transitions ──
//
// The panel's moves, kept pure so they are tested without a DOM: what each button sends, and what the
// screen holds after the answer. The component only wires these to fetch and useState.

export interface ApiRequest {
  method: 'PUT' | 'PATCH' | 'DELETE' | 'POST';
  body?: Record<string, unknown>;
}

/** The connection card: key form, its inputs, and the inline disconnect confirm. */
export interface ConnectionUi {
  formOpen: boolean;
  /** Opened by a button press (Replace keys / Use my own keys) — the Client ID field takes focus. */
  focusClientId: boolean;
  clientId: string;
  secret: string;
  confirmDisconnect: boolean;
}

export type ConnectionEvent =
  | { type: 'openForm' }
  | { type: 'closeForm' }
  | { type: 'input'; field: 'clientId' | 'secret'; value: string }
  | { type: 'askDisconnect' }
  | { type: 'cancelDisconnect' }
  | { type: 'saved' }
  | { type: 'saveFailed' }
  | { type: 'disconnected'; status: PayPalConnectionStatus }
  | { type: 'disconnectFailed' };

/** Not connected or keys rejected → the form is open from the start (no focus grab on page load). */
export function initialConnectionUi(status: PayPalConnectionStatus): ConnectionUi {
  return {
    formOpen: status === 'not_connected' || status === 'failed',
    focusClientId: false,
    clientId: '',
    secret: '',
    confirmDisconnect: false,
  };
}

const CLEARED = { clientId: '', secret: '' };

export function connectionUi(state: ConnectionUi, event: ConnectionEvent): ConnectionUi {
  switch (event.type) {
    case 'openForm':
      return { ...state, ...CLEARED, formOpen: true, focusClientId: true, confirmDisconnect: false };
    case 'closeForm':
      return { ...state, ...CLEARED, formOpen: false, focusClientId: false };
    case 'input':
      return { ...state, [event.field]: event.value };
    case 'askDisconnect':
      return { ...state, confirmDisconnect: true };
    case 'cancelDisconnect':
    case 'disconnectFailed':
      return { ...state, confirmDisconnect: false };
    // Saved keys are never kept in the page — the secret field (and the id) empty once PayPal accepted them.
    case 'saved':
      return { ...state, ...CLEARED, formOpen: false, focusClientId: false, confirmDisconnect: false };
    // A rejected save keeps what was typed so a typo can be fixed.
    case 'saveFailed':
      return state;
    case 'disconnected':
      return { ...state, ...CLEARED, formOpen: event.status === 'not_connected', focusClientId: false, confirmDisconnect: false };
  }
}

/** PUT body for the key form, or null while either field is empty. Trimmed — a pasted newline is not part of a key. */
export function keysSaveRequest(state: ConnectionUi): ApiRequest | null {
  const clientId = state.clientId.trim();
  const secret = state.secret.trim();
  if (!clientId || !secret) return null;
  return { method: 'PUT', body: { clientId, secret } };
}

/** DELETE only after the inline confirm — the first press only asks. */
export function disconnectRequest(state: ConnectionUi): ApiRequest | null {
  return state.confirmDisconnect ? { method: 'DELETE' } : null;
}

/** PATCH body for the limits card: only changed fields; null when the draft is invalid or nothing changed. */
export function limitsSaveRequest(saved: PayPalLimits, draft: LimitsDraft): ApiRequest | null {
  const parsed = parseLimitsDraft(draft);
  if (!parsed.ok) return null;
  const body = changedLimits(saved, parsed.limits);
  return Object.keys(body).length > 0 ? { method: 'PATCH', body } : null;
}

/**
 * After a limits PATCH: take only the limits from the answer. A switch toggled meanwhile has its own
 * request in flight; replacing the whole view here would undo its optimistic state.
 */
export function afterLimitsSaved(view: PayPalSettingsView, saved: PayPalSettingsView): { view: PayPalSettingsView; draft: LimitsDraft } {
  return { view: { ...view, limits: saved.limits }, draft: draftFromLimits(saved.limits) };
}

/** Optimistic toggle: the view to show right away and the PATCH that makes it true. */
export function switchToggle(view: PayPalSettingsView, key: keyof PayPalSwitches): { next: boolean; view: PayPalSettingsView; request: ApiRequest } {
  const next = !view.switches[key];
  return { next, view: withSwitch(view, key, next), request: { method: 'PATCH', body: { [key]: next } } };
}

/** The PATCH failed: put this one switch back. Other fields (a limits save that landed meanwhile) stay. */
export function switchRollback(view: PayPalSettingsView, key: keyof PayPalSwitches, next: boolean): PayPalSettingsView {
  return withSwitch(view, key, !next);
}

/** The PATCH answered: this switch takes the server's value, nothing else is touched. */
export function switchSettle(view: PayPalSettingsView, key: keyof PayPalSwitches, saved: PayPalSettingsView): PayPalSettingsView {
  return withSwitch(view, key, saved.switches[key]);
}

function withSwitch(view: PayPalSettingsView, key: keyof PayPalSwitches, value: boolean): PayPalSettingsView {
  return { ...view, switches: { ...view.switches, [key]: value } };
}
