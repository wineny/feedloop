// Thin PayPal REST client. Money-moving calls (create/capture order, refund) go through
// here, not through the LLM toolkit, so guardrails and idempotency stay in our code.
//
// Secrets rule: the client secret and Authorization header never appear in errors or logs.
// PayPalApiError only carries PayPal's own response (status, name, message, debug id, body).

import { readPayPalEnv, PAYPAL_SANDBOX_BASE_URL } from './env';

export type FetchLike = typeof fetch;

export class PayPalApiError extends Error {
  readonly status: number;
  readonly paypalName: string | null;
  readonly debugId: string | null;
  readonly details: unknown;

  constructor(init: {
    status: number;
    name?: string | null;
    message: string;
    debugId?: string | null;
    details?: unknown;
  }) {
    super(init.message);
    this.name = 'PayPalApiError';
    this.status = init.status;
    this.paypalName = init.name ?? null;
    this.debugId = init.debugId ?? null;
    this.details = init.details;
  }
}

export interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  /** Injected in tests. Defaults to global fetch. */
  fetch?: FetchLike;
  /** Injected in tests. Defaults to Date.now. */
  now?: () => number;
  /** Per-request deadline. A hung PayPal call must not outlive the chat request that made it. */
  timeoutMs?: number;
}

export interface RequestOptions {
  body?: unknown;
  /** Sent as PayPal-Request-Id so retries cannot double-charge or double-refund. */
  requestId?: string;
  headers?: Record<string, string>;
  /**
   * Caller's cancellation (the AI SDK's tool abortSignal, carrying toolMs). Combined with the
   * client's own per-request deadline; whichever fires first aborts the fetch. A money-moving call
   * aborted mid-flight is UNCERTAIN, not failed — see refund.ts.
   */
  signal?: AbortSignal;
}

export interface PayPalLink {
  href: string;
  rel: string;
  method?: string;
}

export interface PayPalOrder {
  id: string;
  status: string;
  links?: PayPalLink[];
  purchase_units?: unknown[];
}

export interface PayPalCapture {
  id: string;
  /** COMPLETED | PENDING | DECLINED | FAILED | REFUNDED | PARTIALLY_REFUNDED */
  status: string;
  amount?: { value: string; currency_code: string };
  create_time?: string;
  [key: string]: unknown;
}

export interface PayPalDispute {
  dispute_id: string;
  status?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface PayPalRefund {
  id: string;
  status: string;
  amount?: { value: string; currency_code: string };
  [key: string]: unknown;
}

export interface CreateOrderInput {
  amountValue: string;
  currencyCode: string;
  description?: string;
  customId?: string;
  returnUrl: string;
  cancelUrl: string;
  requestId: string;
  /** PayPal page language, e.g. en-US. Without it PayPal guesses from the buyer's IP. */
  locale?: string;
  /** NO_SHIPPING for digital goods — the buyer is not asked for an address. */
  shippingPreference?: 'NO_SHIPPING' | 'GET_FROM_FILE' | 'SET_PROVIDED_ADDRESS';
  /** Caller's cancellation (the agent's tool signal). Absent for the pricing page. */
  signal?: AbortSignal;
}

export interface RefundInput {
  amountValue: string;
  currencyCode: string;
  noteToPayer?: string;
  requestId: string;
  signal?: AbortSignal;
}

// Refresh this long before expiry so a token never dies mid-request.
const TOKEN_SKEW_MS = 60_000;
// PayPal answers in well under a second; 15s is generous and still far below the function limit.
const DEFAULT_TIMEOUT_MS = 15_000;
// PayPal-Request-Id limit (Orders/Payments v2 docs). An empty id would silently disable idempotency.
const REQUEST_ID_MAX = 108;

export class PayPalClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private token: { value: string; expiresAt: number; scope: string } | null = null;
  // Concurrent first calls share one token request instead of each hitting /oauth2/token.
  private tokenInFlight: Promise<{ accessToken: string; scope: string }> | null = null;

  constructor(opts: PayPalClientOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.baseUrl = opts.baseUrl ?? PAYPAL_SANDBOX_BASE_URL;
    this.fetchImpl = opts.fetch ?? ((...a) => fetch(...a));
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private signal(external?: AbortSignal): AbortSignal {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    return external ? AbortSignal.any([deadline, external]) : deadline;
  }

  /** Client-credentials token, cached in memory. Returns the token and its scope string. */
  async getAccessToken(): Promise<{ accessToken: string; scope: string }> {
    if (this.token && this.now() < this.token.expiresAt) {
      return { accessToken: this.token.value, scope: this.token.scope };
    }
    if (this.tokenInFlight) return this.tokenInFlight;
    this.tokenInFlight = this.fetchToken().finally(() => {
      this.tokenInFlight = null;
    });
    return this.tokenInFlight;
  }

  private async fetchToken(): Promise<{ accessToken: string; scope: string }> {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: this.signal(),
    });
    const data = await parseBody(res);
    if (!res.ok) throw toApiError(res, data);
    const obj = data as { access_token?: string; expires_in?: number; scope?: string };
    if (!obj || typeof obj.access_token !== 'string' || typeof obj.expires_in !== 'number') {
      throw new PayPalApiError({ status: res.status, message: 'PayPal token response had no access_token', details: null });
    }
    this.token = {
      value: obj.access_token,
      expiresAt: this.now() + obj.expires_in * 1000 - TOKEN_SKEW_MS,
      scope: obj.scope ?? '',
    };
    return { accessToken: this.token.value, scope: this.token.scope };
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    if (opts.requestId !== undefined) {
      // Validate before the token call so a bad id never costs a network round trip.
      if (!opts.requestId || opts.requestId.length > REQUEST_ID_MAX) {
        throw new Error(`PayPal-Request-Id must be 1-${REQUEST_ID_MAX} characters`);
      }
    }
    // Already cancelled: do not even fetch a token. Throwing the signal's reason keeps the
    // "aborted" classification the callers rely on.
    if (opts.signal?.aborted) throw abortError(opts.signal);
    const { accessToken } = await this.getAccessToken();
    const headers: Record<string, string> = {
      ...opts.headers,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
    if (opts.requestId) headers['PayPal-Request-Id'] = opts.requestId;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: this.signal(opts.signal),
    });
    const data = await parseBody(res);
    if (!res.ok) throw toApiError(res, data);
    return data as T;
  }

  async createOrder(
    input: CreateOrderInput,
  ): Promise<{ id: string; status: string; approveUrl: string | null }> {
    const order = await this.request<PayPalOrder>('POST', '/v2/checkout/orders', {
      requestId: input.requestId,
      signal: input.signal,
      body: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            amount: { currency_code: input.currencyCode, value: input.amountValue },
            ...(input.description ? { description: input.description } : {}),
            ...(input.customId ? { custom_id: input.customId } : {}),
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              return_url: input.returnUrl,
              cancel_url: input.cancelUrl,
              user_action: 'PAY_NOW',
              ...(input.locale ? { locale: input.locale } : {}),
              ...(input.shippingPreference ? { shipping_preference: input.shippingPreference } : {}),
            },
          },
        },
      },
    });
    return { id: order.id, status: order.status, approveUrl: findApproveUrl(order.links) };
  }

  getOrder(id: string, opts: { signal?: AbortSignal } = {}): Promise<PayPalOrder> {
    return this.request('GET', `/v2/checkout/orders/${encodeURIComponent(id)}`, { signal: opts.signal });
  }

  captureOrder(id: string, requestId: string): Promise<PayPalOrder> {
    return this.request('POST', `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {
      requestId,
    });
  }

  getCapture(captureId: string, opts: { signal?: AbortSignal } = {}): Promise<PayPalCapture> {
    return this.request('GET', `/v2/payments/captures/${encodeURIComponent(captureId)}`, { signal: opts.signal });
  }

  /**
   * The amount is always sent. PayPal treats a missing amount as a FULL refund,
   * which our guardrails forbid, so there is no code path without it.
   */
  refundCapture(captureId: string, input: RefundInput): Promise<PayPalRefund> {
    return this.request('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      requestId: input.requestId,
      signal: input.signal,
      body: {
        amount: { value: input.amountValue, currency_code: input.currencyCode },
        ...(input.noteToPayer ? { note_to_payer: input.noteToPayer } : {}),
      },
    });
  }

  getRefund(id: string, opts: { signal?: AbortSignal } = {}): Promise<PayPalRefund> {
    return this.request('GET', `/v2/payments/refunds/${encodeURIComponent(id)}`, { signal: opts.signal });
  }

  /**
   * Disputes opened against one capture (any status). Read-only; the refund guardrail passes
   * "has a dispute" from this, never from model text. PayPal answers `{ items: [] }` when none.
   */
  async listDisputesForCapture(captureId: string, opts: { signal?: AbortSignal } = {}): Promise<PayPalDispute[]> {
    const res = await this.request<{ items?: PayPalDispute[] }>(
      'GET',
      `/v1/customer/disputes?disputed_transaction_id=${encodeURIComponent(captureId)}`,
      { signal: opts.signal },
    );
    return res?.items ?? [];
  }

  /** Registers a webhook listener on this app. PayPal answers 400 WEBHOOK_URL_ALREADY_EXISTS for a known URL. */
  createWebhook(url: string, eventTypes: readonly string[]): Promise<PayPalWebhook> {
    return this.request('POST', '/v1/notifications/webhooks', {
      body: { url, event_types: eventTypes.map((name) => ({ name })) },
    });
  }

  /** All webhooks registered on this app (PayPal allows at most 10, so there is no paging). */
  async listWebhooks(): Promise<PayPalWebhook[]> {
    const res = await this.request<{ webhooks?: PayPalWebhook[] }>('GET', '/v1/notifications/webhooks');
    return res?.webhooks ?? [];
  }

  /** Replaces a webhook's event list (JSON Patch on /event_types). */
  async updateWebhookEvents(id: string, eventTypes: readonly string[]): Promise<void> {
    await this.request('PATCH', `/v1/notifications/webhooks/${encodeURIComponent(id)}`, {
      body: [{ op: 'replace', path: '/event_types', value: eventTypes.map((name) => ({ name })) }],
    });
  }

  /** Removes a webhook. PayPal answers 204; a 404 (already gone) surfaces as PayPalApiError for the caller to ignore. */
  async deleteWebhook(id: string): Promise<void> {
    await this.request('DELETE', `/v1/notifications/webhooks/${encodeURIComponent(id)}`);
  }
}

export interface PayPalWebhook {
  id: string;
  url: string;
  event_types?: { name: string }[];
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === 'string' ? reason : 'This operation was aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * True when an error means "the request may or may not have been performed by PayPal": an abort or
 * timeout (ours or the caller's), a network failure, a 5xx, a 408, a 429, or a 409 — PayPal answers
 * 409 RESOURCE_CONFLICT / PREVIOUS_REQUEST_IN_PROGRESS to a replay of a PayPal-Request-Id whose
 * first request is still running (https://developer.paypal.com/api/payments/v2/errors/previous_request_in_progress/):
 * that other request may well succeed. For a money-moving call all of these are UNCERTAIN — the
 * caller must not treat them as "nothing happened". Any other 4xx is a definite answer from PayPal.
 */
export function isUncertainPayPalError(err: unknown): boolean {
  if (err instanceof PayPalApiError) return err.status >= 500 || err.status === 408 || err.status === 409 || err.status === 429;
  // Everything else never carried a PayPal answer: AbortError / TimeoutError from the signals,
  // TypeError("fetch failed") from undici, a JSON parse failure. Uncertain by definition.
  return true;
}

function findApproveUrl(links?: PayPalLink[]): string | null {
  return links?.find((l) => l.rel === 'approve' || l.rel === 'payer-action')?.href ?? null;
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function toApiError(res: Response, data: unknown): PayPalApiError {
  const body = (data ?? {}) as { name?: string; message?: string; error_description?: string };
  return new PayPalApiError({
    status: res.status,
    name: body.name ?? null,
    message: body.message ?? body.error_description ?? `PayPal request failed (${res.status})`,
    debugId: res.headers.get('paypal-debug-id'),
    details: data,
  });
}

export function paypalClientFromEnv(opts: { fetch?: FetchLike } = {}): PayPalClient {
  const env = readPayPalEnv();
  return new PayPalClient({
    clientId: env.clientId,
    clientSecret: env.clientSecret,
    baseUrl: env.baseUrl,
    fetch: opts.fetch,
  });
}
