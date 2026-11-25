// NudgeBee (SPEC-LITE §14.3): the planner's ops autopilot. NudgeBee's workflow polls
// GET /api/ops/overview (routes/ops.ts); this module builds that view and pushes a one-off alert
// to NUDGEBEE_WEBHOOK_URL when a booth first crosses 25 min (deduped per booth per 15 min).
// Keyless-safe: no OPS_TOKEN → the routes answer 401; no webhook URL → nothing is sent.
// The push runs after the ticker's commit, has a 3 s timeout and never throws.
import { all } from '../db/queries';
import type { BoothRow, EventRow } from '../db/queries';
import { isLive } from '../engine/booking';
import { boothView } from '../routes/views';

export const ALERT_WAIT_MIN = 25;
export const ALERT_DEDUPE_MS = 15 * 60_000;
export const MAX_OPS_ARTISTS = 5;
const TIMEOUT_MS = 3_000;

export interface OpsBooth {
  id: number; name: string; event: string; mode: 'live' | 'batch';
  waiting: number; estWaitMin: number; artists: number; paused: boolean;
}
export interface OpsAlert {
  boothId: number; name: string; reason: string;
  estWaitMin: number; waiting: number; artists: number; suggestedArtists: number;
}

/** Booths of live events, plus an alert for each open live booth whose join-now wait is over 25 min. */
export function opsOverview(now: number): { booths: OpsBooth[]; alerts: OpsAlert[] } {
  const events = new Map(all<EventRow>(`SELECT * FROM events`).filter((e) => isLive(e, now)).map((e) => [e.id, e]));
  const rows = all<BoothRow>(
    `SELECT b.*, e.wedding_id FROM booths b JOIN events e ON e.id = b.event_id ORDER BY b.id`)
    .filter((b) => events.has(b.event_id));
  const booths = rows.map((b): OpsBooth => {
    const v = boothView(b, now);
    return {
      id: b.id, name: b.name, event: events.get(b.event_id)!.name, mode: b.mode,
      waiting: v.waiting, estWaitMin: v.waitMin, artists: b.artists, paused: v.paused,
    };
  });
  const alerts = booths
    .filter((b) => b.mode === 'live' && !b.paused && b.estWaitMin > ALERT_WAIT_MIN)
    .map((b): OpsAlert => ({
      boothId: b.id, name: b.name, reason: `${b.name}: ${b.estWaitMin} min, ${b.waiting} waiting`,
      estWaitMin: b.estWaitMin, waiting: b.waiting, artists: b.artists,
      suggestedArtists: Math.min(MAX_OPS_ARTISTS, b.artists + 1),
    }));
  return { booths, alerts };
}

const webhookUrl = (): string => process.env.NUDGEBEE_WEBHOOK_URL ?? '';

const overBefore = new Set<number>();          // booths over the threshold at the last check
const lastSent = new Map<number, number>();    // boothId → last push time

/** Which alerts to push now: booths that just crossed 25 min and weren't pushed in the last 15 min. */
export function dueAlerts(alerts: readonly OpsAlert[], now: number): OpsAlert[] {
  const over = new Set(alerts.map((a) => a.boothId));
  const due = alerts.filter((a) => !overBefore.has(a.boothId) && now - (lastSent.get(a.boothId) ?? -Infinity) >= ALERT_DEDUPE_MS);
  overBefore.clear();
  for (const id of over) overBefore.add(id);
  for (const a of due) lastSent.set(a.boothId, now);
  return due;
}

/** Ticker hook (after commit): push newly crossed booths to NudgeBee's webhook trigger. Fire-and-forget. */
export function pushQueueAlerts(now: number): OpsAlert[] {
  if (!webhookUrl()) return [];
  const due = dueAlerts(opsOverview(now).alerts, now);
  for (const alert of due) {
    void fetch(webhookUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'varisai', type: 'queue_alert', at: new Date(now).toISOString(), alert }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).then((r) => {
      if (!r.ok) console.warn(`[nudgebee] webhook ${r.status}`);
    }, (e: Error) => console.warn('[nudgebee] webhook failed:', e.message));
  }
  return due;
}

/** Test hook. */
export function resetNudgebeeState(): void {
  overBefore.clear();
  lastSent.clear();
}
