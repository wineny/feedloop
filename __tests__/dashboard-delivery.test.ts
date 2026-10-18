import { describe, expect, it } from 'vitest';
import { messageDelivery } from '@/lib/dashboard/feedback-delivery';
const time = '2026-09-13T01:00:00Z';
const later = '2026-09-13T02:00:00Z';
const message = { id: 'original', conversation_id: 'conversation', detected_at: time };
const insights = [{ id: 'insight', message_id: 'original', source_message_ids: ['supplement'], group_id: 'group' }];
const runs = [{ id: 'run', insight_id: null, group_id: 'group' }];
const responses = [{ auto_dev_run_id: 'run', conversation_id: 'conversation', response_type: 'loop_closed', sent_at: time, delivered_at: later }];
describe('dashboard per-message merge delivery', () => {
 it('links primary and supplementary sources through their group run', () => {
  for (const id of ['original', 'supplement']) expect(messageDelivery({ ...message, id }, insights, runs, responses)).toEqual({ returnedAt: later, returnQueuedAt: null });
 });
 it('does not mark another issue in the same conversation as delivered', () => {
  expect(messageDelivery({ ...message, id: 'other' }, [...insights, { id: 'other-insight', message_id: 'other', source_message_ids: [], group_id: 'other-group' }], runs, responses).returnedAt).toBeNull();
 });
 it('does not mark a later report in the same group as delivered', () => {
  expect(messageDelivery({ ...message, id: 'supplement', detected_at: '2026-09-13T03:00:00Z' }, insights, runs, responses).returnedAt).toBeNull();
 });
 it('distinguishes queued delivery and does not attach an older queued notice', () => {
  const queued = [{ ...responses[0], delivered_at: null }];
  expect(messageDelivery(message, insights, runs, queued)).toEqual({ returnedAt: null, returnQueuedAt: time });
  expect(messageDelivery({ ...message, detected_at: later }, insights, runs, queued)).toEqual({ returnedAt: null, returnQueuedAt: null });
 });
 it('supports direct insight runs while rejecting wrong run and conversation', () => {
  expect(messageDelivery(message, insights, [{ ...runs[0], insight_id: 'insight', group_id: null }], responses).returnedAt).toBe(later);
  for (const changed of [{ ...responses[0], auto_dev_run_id: 'other' }, { ...responses[0], conversation_id: 'other' }]) expect(messageDelivery(message, insights, runs, [changed]).returnedAt).toBeNull();
 });
});

it('a previously queued card delivered after a new report does not acknowledge it', () => {
 expect(messageDelivery({ ...message, detected_at: '2026-09-13T01:30:00Z' }, insights, runs, responses)).toEqual({ returnedAt: null, returnQueuedAt: null });
});
