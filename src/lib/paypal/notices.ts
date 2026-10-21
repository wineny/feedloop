// Visitor-facing sentences for the payment path. English, server-fixed, never model output.
//
// The ordinary reply path has Korean notices in the widget route (SLOW/RATE/LIMIT/HOLDING) and
// a Korean holding answer in lib/bot/holding.ts. Those stay as they are: Korean customers of the
// production deployment read them. The payment path is the hackathon demo — judges and the video
// are English (design §10) — so every sentence it can show lives here, one per situation the
// route distinguishes. Dependency-free so UI code can import it too.

/** The agent is still working after the visitor's wait (10 s). Not saved; the answer arrives by polling. */
export const PAYMENT_SLOW_NOTICE = "Got it — checking that now. Your answer will appear here in a moment.";

/** The bot's hourly reply cap is hit. Not saved; clears by itself within the hour. */
export const PAYMENT_RATE_NOTICE =
  "Got it. Automatic replies are paused for a moment because of high traffic — our team will read this and reply here.";

/** The bot's daily reply budget is used up. Not saved; the owner must raise the limit or add a key. */
export const PAYMENT_LIMIT_NOTICE =
  "Got it. Automatic replies are not available right now — our team will read this and reply here.";

/** We could not answer at all (no bot configuration). Not saved; the conversation is escalated. */
export const PAYMENT_HOLDING_NOTICE = "Got it. A team member is looking into this and will reply here.";

/**
 * The one sentence that IS saved as an answer: the agent loop ended without text, the provider
 * failed, or the late reply never came. The route marks the conversation escalated alongside it,
 * so the owner sees it in the inbox.
 */
export const PAYMENT_AGENT_FALLBACK =
  "Sorry, I couldn't finish that just now. Our team has been notified and will follow up here.";

export interface ReplyNotices {
  slow: string;
  rate: string;
  limit: string;
  holding: string;
  /** Saved as the answer when the late reply fails. */
  holdingMessage: string;
}

export const PAYMENT_NOTICES: ReplyNotices = {
  slow: PAYMENT_SLOW_NOTICE,
  rate: PAYMENT_RATE_NOTICE,
  limit: PAYMENT_LIMIT_NOTICE,
  holding: PAYMENT_HOLDING_NOTICE,
  holdingMessage: PAYMENT_AGENT_FALLBACK,
};
