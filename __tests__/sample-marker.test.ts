import { describe, expect, it } from 'vitest';
import { isSampleRef, isSampleVisitor } from '../src/lib/demo/sample-marker';

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
});
