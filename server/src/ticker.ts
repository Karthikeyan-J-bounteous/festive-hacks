// Ticker (SPEC-LITE §6): one setInterval, 10 s. `tick(now)` is exported for tests.
import { tx } from './db/db';
import { BoothRow, EventRow, TicketRow, activeTickets, all, applyPatch } from './db/queries';
import { isEnded, isLive } from './engine/booking';
import { liveEta } from './engine/eta';
import { awayExpired, shouldAutoSkip, skip } from './engine/live';
import { CODE_WINDOW_MS } from './engine/presence';
import { emitBoothChanged, emitCodeRotate, emitEventStatus, emitTicket } from './socket';

export const TICK_MS = 10_000;
export const ALMOST_POSITION = 2;

const liveState = new Map<number, boolean>(); // eventId → last known live
const almostSent = new Set<number>();         // ticket ids already nudged
let lastCodeWindow = -1;

export interface TickResult {
  skipped: number[];
  noShows: number[];
  cancelled: number[];
  almost: number[];
  eventChanges: { eventId: number; live: boolean }[];
}

export function tick(now: number): TickResult {
  const result: TickResult = { skipped: [], noShows: [], cancelled: [], almost: [], eventChanges: [] };
  const changedBooths = new Map<number, number[]>();
  const touch = (boothId: number, ticketId: number) =>
    changedBooths.set(boothId, [...(changedBooths.get(boothId) ?? []), ticketId]);
  const events = all<EventRow>(`SELECT * FROM events`);

  tx(() => {
    // 1. Called at a live booth, not started within 3 min → skip (second skip → no_show).
    const called = all<TicketRow>(
      `SELECT t.* FROM tickets t JOIN booths b ON b.id = t.booth_id WHERE t.status = 'called' AND b.mode = 'live'`);
    for (const t of called.filter((c) => shouldAutoSkip(c, now))) {
      const patch = skip(t, activeTickets(t.booth_id));
      applyPatch(t.id, patch);
      (patch.status === 'no_show' ? result.noShows : result.skipped).push(t.id);
      touch(t.booth_id, t.id);
    }

    // 2. Away for more than 20 min → no_show.
    for (const t of all<TicketRow>(`SELECT * FROM tickets WHERE status = 'away'`).filter((a) => awayExpired(a, now))) {
      applyPatch(t.id, { status: 'no_show' });
      result.noShows.push(t.id);
      touch(t.booth_id, t.id);
    }

    // 3. Ended events → cancel their open tickets.
    for (const e of events.filter((ev) => isEnded(ev, now))) {
      const open = all<TicketRow>(
        `SELECT * FROM tickets WHERE event_id = ? AND status IN ('waiting','away','called','serving')`, e.id);
      for (const t of open) {
        applyPatch(t.id, { status: 'cancelled' });
        result.cancelled.push(t.id);
        touch(t.booth_id, t.id);
      }
    }
  });

  // 3. Event went live / ended → event:status (first sighting just records the state).
  for (const e of events) {
    const live = isLive(e, now);
    const before = liveState.get(e.id);
    liveState.set(e.id, live);
    if (before !== undefined && before !== live) {
      result.eventChanges.push({ eventId: e.id, live });
      emitEventStatus(e.wedding_id, e, live);
    }
  }

  for (const [boothId, ticketIds] of changedBooths) emitBoothChanged(boothId, now, ticketIds);

  // 4. Position ≤ 2 at a live booth → one "almost" nudge per ticket.
  const liveBooths = all<BoothRow>(
    `SELECT b.*, e.wedding_id FROM booths b JOIN events e ON e.id = b.event_id WHERE b.mode = 'live'`);
  for (const booth of liveBooths) {
    const tickets = activeTickets(booth.id);
    for (const t of tickets.filter((x) => x.status === 'waiting' && !almostSent.has(x.id))) {
      const eta = liveEta(t.id, tickets, booth);
      if (eta && eta.position <= ALMOST_POSITION) {
        almostSent.add(t.id);
        result.almost.push(t.id);
        emitTicket(t.id, now, { almost: true });
      }
    }
  }

  // Venue code rotates every 30 s; the ticker runs every 10 s, so emit on the window change.
  const window = Math.floor(now / CODE_WINDOW_MS);
  if (window !== lastCodeWindow) {
    lastCodeWindow = window;
    for (const w of all<{ id: number; qr_secret: string }>(`SELECT id, qr_secret FROM weddings`)) {
      emitCodeRotate(w.id, w.qr_secret, now);
    }
  }

  return result;
}

let timer: NodeJS.Timeout | null = null;

export function startTicker(): void {
  if (timer) return;
  const run = () => {
    try {
      tick(Date.now());
    } catch (e) {
      console.error('ticker failed', e);
    }
  };
  run();
  timer = setInterval(run, TICK_MS);
}

export function stopTicker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** An admin override already emitted `event:status`; record it so the next tick doesn't repeat it. */
export function noteEventLive(eventId: number, live: boolean): void {
  liveState.set(eventId, live);
}

/** Test hook: forget in-memory state between cases. */
export function resetTickerState(): void {
  liveState.clear();
  almostSent.clear();
  lastCodeWindow = -1;
}
