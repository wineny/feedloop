// PayPal webhooks: signature self-verification and the per-event handlers.
//
// Verification (developer.paypal.com/api/rest/webhooks/rest/#self-verification-method):
//   message = `${paypal-transmission-id}|${paypal-transmission-time}|${webhookId}|${crc32(raw body)}`
//   crc32 is the decimal CRC32 of the ORIGINAL bytes (never re-serialised JSON); the signature in
//   paypal-transmission-sig is SHA256withRSA over `message`, checked with the public key from the
//   certificate at paypal-cert-url.
// We verify ourselves instead of calling /v1/notifications/verify-webhook-signature because that
// postback API does not accept Webhook Simulator events, and it would cost a PayPal round trip per event.
//
// Cert URL rule: https, host api.paypal.com or api.sandbox.paypal.com, path under
// /v1/notifications/certs/. Without it, an attacker could point us at a certificate they own.

import { createPublicKey, createVerify, X509Certificate } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { PayPalApiError, type PayPalCapture, type PayPalClient } from './client';
import { applyCapturedOrder, captureCheckout } from './capture';
import { isStuckAction, reconcileAction } from './refund';
import type { PaymentsStore } from './store';

export const CERT_HOSTS = new Set(['api.paypal.com', 'api.sandbox.paypal.com']);
const CERT_PATH = /^\/v1\/notifications\/certs\/CERT-[A-Za-z0-9-]+$/;

/** Webhook Simulator events are signed with this literal instead of a real webhook id. */
export const SIMULATOR_WEBHOOK_ID = 'WEBHOOK_ID';

export interface TransmissionHeaders {
  transmissionId: string;
  transmissionTime: string;
  transmissionSig: string;
  certUrl: string;
  authAlgo: string;
}

export function readTransmissionHeaders(h: Headers): TransmissionHeaders | null {
  const transmissionId = h.get('paypal-transmission-id');
  const transmissionTime = h.get('paypal-transmission-time');
  const transmissionSig = h.get('paypal-transmission-sig');
  const certUrl = h.get('paypal-cert-url');
  const authAlgo = h.get('paypal-auth-algo') ?? 'SHA256withRSA';
  if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl) return null;
  return { transmissionId, transmissionTime, transmissionSig, certUrl, authAlgo };
}

/** `sandbox` (when known) pins the host to that environment: a live bot never takes a sandbox cert. */
export function isAllowedCertUrl(value: string, opts: { sandbox?: boolean } = {}): boolean {
  try {
    const u = new URL(value);
    const hostOk =
      opts.sandbox === undefined
        ? CERT_HOSTS.has(u.hostname)
        : u.hostname === (opts.sandbox ? 'api.sandbox.paypal.com' : 'api.paypal.com');
    return (
      u.protocol === 'https:' &&
      hostOk &&
      (u.port === '' || u.port === '443') &&
      u.search === '' &&
      CERT_PATH.test(u.pathname)
    );
  } catch {
    return false;
  }
}

export function signedMessage(h: TransmissionHeaders, webhookId: string, raw: Buffer): string {
  return `${h.transmissionId}|${h.transmissionTime}|${webhookId}|${crc32(raw) >>> 0}`;
}

export type CertLoader = (url: string) => Promise<string>;

const CERT_MAX_BYTES = 16 * 1024;
const CERT_TIMEOUT_MS = 5_000;
const certCache = new Map<string, string>();
// Forged requests can name cert ids that do not exist; remember failures briefly so each one
// does not cost another 5-second download.
const certFailures = new Map<string, number>();
const CERT_FAILURE_TTL_MS = 60_000;

/**
 * Downloads (and caches per instance) the signing certificate. A PEM certificate must be inside
 * its validity window. Only called for URLs that passed `isAllowedCertUrl`.
 */
export const fetchPayPalCert: CertLoader = async (url) => {
  const cached = certCache.get(url);
  if (cached) return cached;
  if ((certFailures.get(url) ?? 0) > Date.now()) throw new Error('cert recently failed');
  if (certFailures.size > 1000) certFailures.clear();
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(CERT_TIMEOUT_MS), redirect: 'error' });
  } catch (err) {
    certFailures.set(url, Date.now() + CERT_FAILURE_TTL_MS);
    throw err;
  }
  if (!res.ok) {
    certFailures.set(url, Date.now() + CERT_FAILURE_TTL_MS);
    throw new Error(`cert download failed (${res.status})`);
  }
  const pem = await res.text();
  if (pem.length > CERT_MAX_BYTES) throw new Error('cert too large');
  if (pem.includes('BEGIN CERTIFICATE')) {
    const cert = new X509Certificate(pem);
    const now = Date.now();
    if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) {
      throw new Error('cert outside its validity window');
    }
  }
  certCache.set(url, pem);
  return pem;
};

/**
 * True only for a well-formed, correctly signed transmission. Tries each webhook id in order
 * (the bot's real id, plus the simulator literal when explicitly allowed). Never throws.
 */
export async function verifyTransmission(input: {
  headers: TransmissionHeaders;
  raw: Buffer;
  webhookIds: string[];
  /** The bot's PayPal environment; pins the cert host. */
  sandbox?: boolean;
  loadCert?: CertLoader;
}): Promise<boolean> {
  const { headers, raw } = input;
  if (headers.authAlgo !== 'SHA256withRSA') return false;
  if (!isAllowedCertUrl(headers.certUrl, { sandbox: input.sandbox })) return false;
  let pem: string;
  try {
    pem = await (input.loadCert ?? fetchPayPalCert)(headers.certUrl);
  } catch (err) {
    console.error('[paypal-webhook] cert load failed', { message: (err as Error).message });
    return false;
  }
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    return false;
  }
  const sig = Buffer.from(headers.transmissionSig, 'base64');
  for (const id of input.webhookIds) {
    const verifier = createVerify('SHA256');
    verifier.update(signedMessage(headers, id, raw));
    if (verifier.verify(key, sig)) return true;
  }
  return false;
}

/** Simulator events are only accepted when someone turned this on for a sandbox test. */
export function webhookIdsFor(webhookId: string, opts: { sandbox: boolean }): string[] {
  const ids = [webhookId];
  if (opts.sandbox && process.env.PAYPAL_WEBHOOK_ALLOW_SIMULATOR === '1') ids.push(SIMULATOR_WEBHOOK_ID);
  return ids;
}

// ── events ───────────────────────────────────────────────────────────────────

export interface WebhookEvent {
  id: string;
  event_type: string;
  resource_type?: string;
  resource?: { id?: string; [key: string]: unknown };
}

export function parseWebhookEvent(raw: Buffer): WebhookEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  const e = value as Partial<WebhookEvent> | null;
  if (!e || typeof e.id !== 'string' || typeof e.event_type !== 'string') return null;
  return e as WebhookEvent;
}

const PAYPAL_API_HOSTS = new Set(['api.paypal.com', 'api-m.paypal.com', 'api.sandbox.paypal.com', 'api-m.sandbox.paypal.com']);

/**
 * The capture id behind a refund resource: its `up` link, https://api(-m)(.sandbox).paypal.com/v2/payments/captures/{id}.
 * Anything else (another host, another path, no link) → null. Exported for tests.
 */
export function captureIdFromRefundResource(resource: unknown): string | null {
  const links = (resource as { links?: unknown } | null)?.links;
  if (!Array.isArray(links)) return null;
  for (const link of links) {
    const l = link as { rel?: unknown; href?: unknown };
    if (l?.rel !== 'up' || typeof l.href !== 'string') continue;
    let url: URL;
    try {
      url = new URL(l.href);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || !PAYPAL_API_HOSTS.has(url.hostname)) continue;
    const m = /^\/v2\/payments\/captures\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
    if (m) return m[1];
  }
  return null;
}

/** Events we store now and act on later (reversals, disputes). */
export const RECORD_ONLY = /^(PAYMENT\.CAPTURE\.REFUNDED|PAYMENT\.CAPTURE\.REVERSED|CUSTOMER\.DISPUTE\..+)$/;

export type HandleOutcome =
  | { kind: 'captured' | 'already_captured' | 'pending' | 'failed' }
  | { kind: 'ignored'; reason: string }
  | { kind: 'recorded' }
  /** A stuck refund action for this capture was reconciled (its new status in `outcome`). */
  | { kind: 'reconciled'; outcome: string };

export interface WebhookDeps {
  store: PaymentsStore;
  paypal: PayPalClient;
}

/**
 * Acts on a verified event. Each branch re-reads the resource from PayPal and never trusts
 * amounts or statuses in the webhook body. Idempotent: safe to run again for the same event.
 * Throws on infrastructure failure so the route can answer 500 and PayPal retries.
 */
export async function handleWebhookEvent(
  deps: WebhookDeps,
  botId: string,
  event: WebhookEvent,
): Promise<HandleOutcome> {
  const resourceId = typeof event.resource?.id === 'string' ? event.resource.id : null;

  if (event.event_type === 'CHECKOUT.ORDER.APPROVED') {
    if (!resourceId) return { kind: 'ignored', reason: 'no order id' };
    const result = await captureCheckout(deps, { botId, orderId: resourceId });
    if (result.ok) {
      if (result.order.status === 'approved') return { kind: 'pending' };
      return { kind: result.changed ? 'captured' : 'already_captured' };
    }
    if (result.error === 'not_found') return { kind: 'ignored', reason: 'unknown order' };
    if (result.error === 'paypal_failed') throw new Error('capture failed at PayPal');
    return { kind: 'ignored', reason: result.error };
  }

  if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
    if (!resourceId) return { kind: 'ignored', reason: 'no capture id' };
    let capture: PayPalCapture & { supplementary_data?: { related_ids?: { order_id?: string } } };
    try {
      capture = await deps.paypal.getCapture(resourceId);
    } catch (err) {
      // Not ours (or a simulator id): retrying will never find it. Anything else → retry.
      if (err instanceof PayPalApiError && err.status === 404) return { kind: 'ignored', reason: 'unknown capture' };
      throw err;
    }
    const orderId = capture.supplementary_data?.related_ids?.order_id;
    if (!orderId) return { kind: 'ignored', reason: 'capture has no order id' };
    const row = await deps.store.getOrder(orderId);
    if (!row || row.bot_id !== botId) return { kind: 'ignored', reason: 'unknown order' };
    if (row.status === 'captured') return { kind: 'already_captured' };
    if (capture.status !== 'COMPLETED') return { kind: 'ignored', reason: `capture ${capture.status}` };
    const order = await deps.paypal.getOrder(orderId);
    const result = await applyCapturedOrder(deps, row, order);
    if (!result.ok) throw new Error(`capture sync failed: ${result.error}`);
    return { kind: result.changed ? 'captured' : 'already_captured' };
  }

  if (event.event_type === 'PAYMENT.CAPTURE.DENIED' || event.event_type === 'PAYMENT.CAPTURE.DECLINED') {
    // A held (PENDING) capture that PayPal finally refused. Without this the receipt says
    // "processing" forever.
    if (!resourceId) return { kind: 'ignored', reason: 'no capture id' };
    let capture: PayPalCapture & { supplementary_data?: { related_ids?: { order_id?: string } } };
    try {
      capture = await deps.paypal.getCapture(resourceId);
    } catch (err) {
      if (err instanceof PayPalApiError && err.status === 404) return { kind: 'ignored', reason: 'unknown capture' };
      throw err;
    }
    const orderId = capture.supplementary_data?.related_ids?.order_id;
    if (!orderId) return { kind: 'ignored', reason: 'capture has no order id' };
    const row = await deps.store.getOrder(orderId);
    if (!row || row.bot_id !== botId) return { kind: 'ignored', reason: 'unknown order' };
    if (capture.status !== 'DECLINED' && capture.status !== 'DENIED' && capture.status !== 'FAILED') {
      return { kind: 'ignored', reason: `capture ${capture.status}` };
    }
    const failed = await deps.store.updateOrder(orderId, botId, ['created', 'approved'], { status: 'failed' });
    return failed ? { kind: 'failed' } : { kind: 'ignored', reason: `order ${row.status}` };
  }

  if (event.event_type === 'PAYMENT.CAPTURE.REFUNDED') {
    // The resource is a REFUND (resource.id = refund id); its capture is the `up` link
    // (https://developer.paypal.com/api/payments/v2/captures-refund/ — capture_refunded callback).
    // If we have a refund action for that capture whose answer we never saw (executing/unknown),
    // this is the moment to finish it. reconcileAction re-reads PayPal (GET refund, or the idempotent
    // re-POST); nothing here trusts the webhook body's amounts or status, and the link is only used
    // as a lookup key after its host and path were validated.
    const captureId = captureIdFromRefundResource(event.resource);
    if (!captureId) return { kind: 'recorded' };
    const action = await deps.store.latestRefundAction(botId, captureId);
    if (action && isStuckAction(action)) {
      const outcome = await reconcileAction(deps, action);
      return { kind: 'reconciled', outcome: outcome.status };
    }
    return { kind: 'recorded' };
  }

  if (RECORD_ONLY.test(event.event_type)) return { kind: 'recorded' };
  return { kind: 'ignored', reason: 'event type not handled' };
}
