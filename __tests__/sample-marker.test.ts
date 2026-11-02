import { describe, expect, it } from 'vitest';
import { isSampleConversation, isSampleRef, isSampleVisitor } from '../src/lib/demo/sample-marker';

describe('sample-marker', () => {
  it('isSampleRef matches only the SAMPLE- prefix', () => {
    expect(isSampleRef('SAMPLE-CAP-0001')).toBe(true);
    expect(isSampleRef('5O190127TN364715T')).toBe(false);
    expect(isSampleRef('sample-CAP-1')).toBe(false);
    expect(isSampleRef(null)).toBe(false);
    expect(isSampleRef(undefined)).toBe(false);
    expect(isSampleRef('')).toBe(false);
  });

  it('isSampleVisitor matches only the sample- prefix', () => {
    expect(isSampleVisitor('sample-visitor-01')).toBe(true);
    expect(isSampleVisitor('visitor-abc')).toBe(false);
    expect(isSampleVisitor('SAMPLE-visitor')).toBe(false);
    expect(isSampleVisitor(null)).toBe(false);
    expect(isSampleVisitor(undefined)).toBe(false);
  });

  it('isSampleConversation needs both the web source and the sample- visitor', () => {
    expect(isSampleConversation({ source: 'web', external_user_id: 'sample-visitor-01' })).toBe(true);
    expect(isSampleConversation({ source: 'telegram', external_user_id: 'sample-visitor-01' })).toBe(false);
    expect(isSampleConversation({ source: 'channel', external_user_id: 'sample-x' })).toBe(false);
    expect(isSampleConversation({ source: 'web', external_user_id: 'visitor-abc' })).toBe(false);
    expect(isSampleConversation({ source: null, external_user_id: 'sample-visitor-01' })).toBe(false);
    expect(isSampleConversation({})).toBe(false);
  });
});
