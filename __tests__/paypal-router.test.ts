// Payment router (design v2 §2): rules only, no LLM. Four signals; any one routes.
import { describe, expect, it } from 'vitest';
import {
  hasPaymentKeyword,
  looksLikePayPalId,
  previousReplyWasPayment,
  routePayment,
  type RouterTurn,
} from '@/lib/paypal/router';
import { PAYMENT_AGENT_RESPONSE_TYPE, PAYMENT_RESPONSE_TYPE } from '@/lib/paypal/response-types';

const base = { recentTurns: [] as RouterTurn[], hasOpenAction: false };

describe('routePayment — keywords', () => {
  it.each([
    'I want a refund',
    'Refunded yet?',
    'you charged me twice',
    'How do I pay for the Pro plan?',
    'I paid yesterday and nothing happened',
    'Can I get my money back',
    'cancel my order please',
    'where is my receipt',
    'Is PayPal supported?',
    '환불해 주세요',
    '결제가 안 돼요',
    '주문 취소하고 싶어요',
    '영수증 보내 주세요',
  ])('routes %j', (text) => {
    expect(routePayment({ ...base, text })).toEqual({ route: true, reason: 'keyword' });
  });

  it.each([
    'The login button is broken',
    'How do I export my data?',
    'in order to sign up I need an invite',
    'the payload is empty',
    'a billion users',
    '버그가 있어요',
    'thanks!',
  ])('does not route %j', (text) => {
    expect(routePayment({ ...base, text })).toEqual({ route: false });
  });

  it('is case-insensitive for English words', () => {
    expect(hasPaymentKeyword('REFUND')).toBe(true);
    expect(hasPaymentKeyword('Paid')).toBe(true);
  });
});

describe('routePayment — PayPal ids', () => {
  it('recognises order and capture ids (17 alphanumerics with letters and digits)', () => {
    expect(looksLikePayPalId('5O190127TN364715T')).toBe(true);
    expect(looksLikePayPalId('here: 3C679366HH908993F thanks')).toBe(true);
    expect(looksLikePayPalId('3c679366hh908993f')).toBe(true);
    expect(routePayment({ ...base, text: '5O190127TN364715T' })).toEqual({ route: true, reason: 'order_id' });
  });

  it('ignores tokens of the wrong length or with no digits/letters', () => {
    expect(looksLikePayPalId('ABCDEFGHIJKLMNOPQ')).toBe(false);
    expect(looksLikePayPalId('12345678901234567')).toBe(false);
    expect(looksLikePayPalId('5O190127TN364715')).toBe(false);
    expect(looksLikePayPalId('X5O190127TN364715TX')).toBe(false);
  });
});

describe('routePayment — previous reply', () => {
  const agentTurn: RouterTurn = { id: 'r1', kind: 'ai', responseType: PAYMENT_AGENT_RESPONSE_TYPE };
  const paymentTurn: RouterTurn = { id: 'r2', kind: 'ai', responseType: PAYMENT_RESPONSE_TYPE };
  const aiTurn: RouterTurn = { id: 'r3', kind: 'ai', responseType: 'ai' };
  const user = (id: string): RouterTurn => ({ id, kind: 'user' });

  it('routes a bare follow-up when the last reply came from the payment agent', () => {
    const recentTurns = [user('m1'), agentTurn, user('m2')];
    expect(routePayment({ ...base, text: 'abc@example.com', recentTurns, currentMessageId: 'm2' })).toEqual({
      route: true,
      reason: 'previous_turn',
    });
  });

  it('also counts a server-fixed payment sentence as the previous reply', () => {
    expect(previousReplyWasPayment([user('m1'), paymentTurn, user('m2')], 'm2')).toBe(true);
  });

  it('does not route when the last reply was an ordinary AI answer or an operator', () => {
    expect(previousReplyWasPayment([user('m1'), aiTurn, user('m2')], 'm2')).toBe(false);
    expect(previousReplyWasPayment([user('m1'), agentTurn, { kind: 'operator', responseType: 'operator' }, user('m2')], 'm2')).toBe(false);
  });

  it('skips the current message and intermediate visitor turns', () => {
    expect(previousReplyWasPayment([agentTurn, user('m1'), user('m2')], 'm2')).toBe(true);
    expect(previousReplyWasPayment([user('m2')], 'm2')).toBe(false);
  });
});

describe('routePayment — open action', () => {
  it('routes any message while a refund is pending or executing', () => {
    expect(routePayment({ ...base, text: 'any news?', hasOpenAction: true })).toEqual({
      route: true,
      reason: 'open_action',
    });
  });

  it('returns no route for an empty message without other signals', () => {
    expect(routePayment({ ...base, text: '   ' })).toEqual({ route: false });
  });
});
