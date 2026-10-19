/**
 * What the StreamerSongList and StreamElements clients have in common:
 * waiting when the service says so, fetching one request at a time, merging a
 * burst of events into one fetch, and polling as a backstop. Small functions
 * the clients call, not a base class: each client still decides what to fetch.
 */

type Timer = ReturnType<typeof setTimeout>;

/** The longest wait honored, whatever the service asks for. */
const MAX_RETRY_AFTER_S = 600;

/**
 * How long to stay quiet after a 429 (slow down) or 503 (down for
 * maintenance), from the Retry-After header or a default; 0 for any other
 * response. The caller keeps `Date.now() + this` as its backoff deadline.
 */
export function retryAfterMs(res: { status: number; headers?: { get(name: string): string | null } }): number {
  if (res.status !== 429 && res.status !== 503) return 0;
  const wait = Number(res.headers?.get("retry-after")) || (res.status === 429 ? 60 : 120);
  return Math.min(wait, MAX_RETRY_AFTER_S) * 1000;
}

/**
 * One fetch at a time. A call made while one is running fetches again
 * afterward, because the running request may have started before the change
 * it was asked about. `fetchOnce` handles its own errors.
 */
export function singleFlight(fetchOnce: () => Promise<void>, isStopped: () => boolean): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let again = false;
  return () => {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    inFlight = (async () => {
      do {
        again = false;
        await fetchOnce();
      } while (again && !isStopped());
      inFlight = null;
    })();
    return inFlight;
  };
}

/** Collapse a burst of calls into one: the first starts the wait, later ones during it add nothing. */
export function debounce(ms: number, fn: () => void): { run(): void; cancel(): void } {
  let timer: Timer | null = null;
  return {
    run() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, ms);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * Self-rescheduling, so a slow response never stacks polls behind it. The
 * next poll waits for the polling interval or the service's backoff,
 * whichever is longer.
 */
export function pollLoop(o: {
  isStopped: () => boolean;
  intervalMs: () => number;
  backoffUntil: () => number;
  tick: () => Promise<void>;
}): { schedule(): void; cancel(): void } {
  let timer: Timer | null = null;
  const loop = {
    schedule(): void {
      // A poll that finishes after disconnect() mustn't start another.
      if (o.isStopped()) return;
      const delay = Math.max(o.intervalMs(), o.backoffUntil() - Date.now());
      // One poll loop at a time: connecting again replaces the old timer rather than leaving it running.
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        if (o.isStopped()) return;
        await o.tick();
        if (!o.isStopped()) loop.schedule();
      }, delay);
    },
    cancel(): void {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
  return loop;
}
