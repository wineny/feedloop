import { randomUUID } from 'node:crypto';
import { getServiceRoleClient } from '@/lib/supabase';

export interface DraftGateLease {
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

/** Distinguish optional coordination failures from genuine GitHub read/write errors. */
export class DraftGateLockError extends Error {}

async function lockRpc(name: string, args: Record<string, string | number>, signal?: AbortSignal) {
  try {
    const request = getServiceRoleClient().rpc(name, args);
    const { data, error } = await (signal ? request.abortSignal(signal) : request);
    if (error) throw new Error(error.message);
    return data;
  } catch (error) {
    throw new DraftGateLockError(`${name}: ${error instanceof Error ? error.message : 'RPC unavailable'}`);
  }
}

/** Shared lease for workers on separate instances; unavailable RPCs stop writes, not reads. */
export async function acquireDraftGateLease(key: string, signal?: AbortSignal): Promise<DraftGateLease | null> {
  const identity = { p_key: key, p_owner: randomUUID() };
  const data = await lockRpc('claim_draft_pr_gate', { ...identity, p_ttl_seconds: 300 }, signal);
  if (data !== true) return null;
  return {
    async assertOwned() {
      const data = await lockRpc('owns_draft_pr_gate', identity, signal);
      if (data !== true) throw new DraftGateLockError('Draft gate lease expired or unavailable');
    },
    async release() {
      await lockRpc('release_draft_pr_gate', identity);
    },
  };
}
