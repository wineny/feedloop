// Marks seeded sample history (see scripts/seed-sample-history.ts) so it can be badged,
// never sent to PayPal, and removed later. Real PayPal ids are [A-Z0-9] and never contain
// '-', so a 'SAMPLE-' prefix cannot collide with one. No Node imports: used by client code too.
export const SAMPLE_REF_PREFIX = 'SAMPLE-';
export const SAMPLE_VISITOR_PREFIX = 'sample-';

export function isSampleRef(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(SAMPLE_REF_PREFIX);
}

export function isSampleVisitor(externalUserId: string | null | undefined): boolean {
  return typeof externalUserId === 'string' && externalUserId.startsWith(SAMPLE_VISITOR_PREFIX);
}
