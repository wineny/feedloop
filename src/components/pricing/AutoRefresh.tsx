'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

interface AutoRefreshProps {
  /** Milliseconds between refreshes. */
  everyMs?: number;
  /** Stop after this many refreshes (about a minute by default). */
  times?: number;
}

/**
 * Re-renders the receipt while the order is still settling (`created` / `approved`): the webhook
 * or a racing return request may finish the capture a moment after the buyer lands here.
 */
export function AutoRefresh({ everyMs = 4_000, times = 15 }: AutoRefreshProps) {
  const router = useRouter();
  useEffect(() => {
    let count = 0;
    const id = setInterval(() => {
      count += 1;
      router.refresh();
      if (count >= times) clearInterval(id);
    }, everyMs);
    return () => clearInterval(id);
  }, [router, everyMs, times]);
  return null;
}
