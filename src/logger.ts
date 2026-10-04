export type Stage = 'fetch' | 'generate' | 'draft' | 'label';
type Event = 'started' | 'startup_failed' | 'completed' | 'email_failed';
export type Counts = { selected: number; succeeded: number; failed: number; skipped: number };

export function logEvent(event: Event, stage?: Stage, counts?: Counts): void {
  console.log(JSON.stringify({ event, stage,
    ...(counts ? { selected: counts.selected, succeeded: counts.succeeded,
      failed: counts.failed, skipped: counts.skipped } : {}),
  }));
}
