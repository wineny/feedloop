// The operator's decision on a refund that waits for approval (design v2 §4, stage 3 task 4).
//
// POST { decision: 'approve' | 'reject' }
//  - who: anyone who may operate the bot — its owner or an approver (bot_members). Approving IS the
//    approver role's job; settings stay owner-only (resolveOwnedBots) elsewhere.
//  - what: the action must belong to this conversation and this bot (the conversation is the path).
//  - once: payment_action_decide is one conditional UPDATE (… WHERE status = 'pending'); zero rows =
//    already decided → 409 with the row as it is now. A double click cannot refund twice.
//  - approve: the capture is re-read from PayPal right before sending (executeApprovedAction), then
//    the same PayPal call as the auto path, keyed by the row id. The visitor-facing sentence and the
//    widget card come with task 5; this route returns the outcome to the inbox.
//  - the "needs a person" badge goes down on either decision: a person acted.

import { NextResponse } from 'next/server';
import { resolveAccessibleBots } from '@/lib/auth/ownership';
import { getConversationOwner } from '@/lib/bot/conversations';
import { toPaymentActionView } from '@/lib/paypal/action-view';
import { resolvePayPalBot } from '@/lib/paypal/bot';
import { executeApprovedAction } from '@/lib/paypal/refund';
import { supabasePaymentsStore } from '@/lib/paypal/store';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ conversationId: string; actionId: string }> },
) {
  const { conversationId, actionId } = await params;

  const conversation = await getConversationOwner(conversationId);
  if (!conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  const auth = await resolveAccessibleBots(conversation.bot_id);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let payload: { decision?: unknown };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const decision = payload.decision;
  if (decision !== 'approve' && decision !== 'reject') {
    return NextResponse.json({ error: 'decision must be approve or reject' }, { status: 400 });
  }

  const store = supabasePaymentsStore();
  const action = await store.getAction(actionId, conversation.bot_id);
  // Same answer for "no such row" and "another conversation's row": the path is the scope.
  if (!action || action.conversation_id !== conversationId || action.kind !== 'refund') {
    return NextResponse.json({ error: 'Refund request not found' }, { status: 404 });
  }

  const decided = await store.decideAction({ actionId, botId: conversation.bot_id, decision, userId: auth.userId });
  if (!decided.updated) {
    return NextResponse.json(
      { error: 'This request was already decided', action: toPaymentActionView(decided.action) },
      { status: 409 },
    );
  }

  // A person acted — but the badge means "something here still needs a person". The database lowers
  // it only when no refund of this conversation is still pending and the visitor has not asked for a
  // human, under the same lock that opens refunds (no window for a new pending row). A failed call
  // leaves the badge up: the safe side.
  const escalationCleared = await store.clearRefundAttention(conversationId, conversation.bot_id).catch((err) => {
    console.error('[inbox] clearRefundAttention failed; badge left up', { conversationId, message: (err as Error).message });
    return false;
  });

  if (decision === 'reject') {
    return NextResponse.json({ decision, outcome: { status: 'rejected' }, action: toPaymentActionView(decided.action), escalationCleared });
  }

  const paypal = await resolvePayPalBot(conversation.bot_id);
  if (!paypal.ok) {
    // The row is `executing` with nothing sent; the reaper re-runs the capture check and sends when
    // the bot has credentials again. Tell the operator the truth instead of pretending it went out.
    console.error('[inbox] approve: bot has no PayPal client', { botId: conversation.bot_id, reason: paypal.reason });
    const current = (await store.getAction(actionId, conversation.bot_id)) ?? decided.action;
    return NextResponse.json(
      {
        decision,
        outcome: { status: 'unknown', reason: 'paypal_not_connected' },
        action: toPaymentActionView(current),
        escalationCleared,
        error: 'Approval saved, but this bot has no PayPal connection. The refund will be sent once PayPal is connected.',
      },
      { status: 502 },
    );
  }

  const outcome = await executeApprovedAction({ store, paypal: paypal.bot.client }, decided.action);
  const current = (await store.getAction(actionId, conversation.bot_id)) ?? outcome.action;
  const body = {
    decision,
    outcome:
      outcome.status === 'executed'
        ? { status: 'executed', refundId: outcome.refundId }
        : outcome.status === 'failed'
          ? { status: 'failed', reason: outcome.reason }
          : { status: outcome.status },
    action: toPaymentActionView(current),
    escalationCleared,
  };
  // 200 for every decided outcome, including a PayPal refusal: the decision was taken and recorded;
  // the card shows what PayPal said.
  return NextResponse.json(body);
}

