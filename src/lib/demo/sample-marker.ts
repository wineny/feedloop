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

/**
 * A seeded sample conversation: the seed only writes web conversations with a `sample-` visitor id. Other
 * sources (channel, telegram, kakao) carry platform ids we do not control, so the prefix alone is not enough.
 */
export function isSampleConversation(c: { source?: string | null; external_user_id?: string | null }): boolean {
  return c.source === 'web' && isSampleVisitor(c.external_user_id);
}
