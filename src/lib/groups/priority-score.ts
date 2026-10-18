export const PRIORITY_WEIGHTS = { people: 3, insights: 1, core: 20 } as const;
export interface GroupPriority { score: number; core: boolean | null; reason: string | null }

export function groupPriority(people: number, insights: number, core: boolean | null = null, reason: string | null = null): GroupPriority {
  return {
    score: people * PRIORITY_WEIGHTS.people + insights * PRIORITY_WEIGHTS.insights + (core ? PRIORITY_WEIGHTS.core : 0),
    core,
    reason: core === null ? null : reason,
  };
}

export function compareGroupPriority(a: { status: string; priority: GroupPriority; createdAt: string }, b: { status: string; priority: GroupPriority; createdAt: string }): number {
  return Number(a.status === 'merged') - Number(b.status === 'merged')
    || b.priority.score - a.priority.score || Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

