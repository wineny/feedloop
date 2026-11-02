import { describe, expect, it } from 'vitest';
import { normalizeTriage, TRIAGE_REASON_MAX } from '@/lib/groups/triage';

describe('normalizeTriage', () => {
  it('accepts the three verdicts, case and spacing tolerant', () => {
    expect(normalizeTriage('fix', 'broken')).toEqual({ triage: 'fix', triage_reason: 'broken' });
    expect(normalizeTriage(' Wont_Fix ')).toEqual({ triage: 'wont_fix' });
    expect(normalizeTriage('needs_decision', 'x')?.triage).toBe('needs_decision');
  });
  it('rejects anything else', () => {
    for (const bad of ['maybe', '', null, undefined, 3, {}, 'won\'t fix']) expect(normalizeTriage(bad, 'r')).toBeNull();
  });
  it('collapses the reason to one trimmed, capped line and omits it when empty', () => {
    expect(normalizeTriage('fix', 'a\n  b\t c')?.triage_reason).toBe('a b c');
    expect(normalizeTriage('fix', 'x'.repeat(TRIAGE_REASON_MAX + 50))?.triage_reason).toHaveLength(TRIAGE_REASON_MAX);
    expect(normalizeTriage('fix', '   ')).toEqual({ triage: 'fix' });
    expect(normalizeTriage('fix', 42)).toEqual({ triage: 'fix' });
  });
});
