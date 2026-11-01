import { describe, expect, it } from 'vitest';
import { isSampleUrl } from '@/lib/demo/sample-url';

describe('isSampleUrl', () => {
  it('flags the placeholder GitHub URLs used by sample data', () => {
    expect(isSampleUrl('https://github.com/example/demo/pull/128')).toBe(true);
    expect(isSampleUrl('https://github.com/example/rona')).toBe(true);
  });
  it('keeps real URLs clickable', () => {
    expect(isSampleUrl('https://github.com/wineny/feedloop/pull/1')).toBe(false);
    expect(isSampleUrl('https://github.com/examples/x')).toBe(false);
    expect(isSampleUrl(null)).toBe(false);
  });
});
