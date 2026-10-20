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
  status: string;
  amount?: { value: string; currency_code: string };
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
}

export interface RefundInput {
  amountValue: string;
  currencyCode: string;
  noteToPayer?: string;
  requestId: string;
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

  private signal(): AbortSignal {
    return AbortSignal.timeout(this.timeoutMs);
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
      signal: this.signal(),
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

  getOrder(id: string): Promise<PayPalOrder> {
    return this.request('GET', `/v2/checkout/orders/${encodeURIComponent(id)}`);
  }

  captureOrder(id: string, requestId: string): Promise<PayPalOrder> {
    return this.request('POST', `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {
      requestId,
    });
  }

  getCapture(captureId: string): Promise<PayPalCapture> {
    return this.request('GET', `/v2/payments/captures/${encodeURIComponent(captureId)}`);
  }

  /**
   * The amount is always sent. PayPal treats a missing amount as a FULL refund,
   * which our guardrails forbid, so there is no code path without it.
   */
  refundCapture(captureId: string, input: RefundInput): Promise<PayPalRefund> {
    return this.request('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      requestId: input.requestId,
      body: {
        amount: { value: input.amountValue, currency_code: input.currencyCode },
        ...(input.noteToPayer ? { note_to_payer: input.noteToPayer } : {}),
      },
    });
  }

  getRefund(id: string): Promise<PayPalRefund> {
    return this.request('GET', `/v2/payments/refunds/${encodeURIComponent(id)}`);
  }
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
