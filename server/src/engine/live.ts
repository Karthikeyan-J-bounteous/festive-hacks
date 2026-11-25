// Live queue engine (SPEC-LITE §6 "Live queue"). Pure: callers pass `now` and current rows,
// and get back what to write. No I/O.
import { Booth, EngineError, MINUTE, Ticket, TicketPatch, TicketStatus, bySeq, isInProgress } from './types';

export const VIP_EVERY = 3;                 // 1 VIP per 3 regulars
export const AUTO_SKIP_AFTER_MS = 3 * MINUTE;
export const AWAY_TIMEOUT_MS = 20 * MINUTE;

/**
 * The order callNext would serve the waiting tickets in, ignoring user conflicts.
 * Applies the VIP 1:3 ratio step by step, starting from the booth's current counter.
 */
export function orderWaiting(waiting: readonly Ticket[], regularsSinceVip: number): Ticket[] {
  const vips = waiting.filter((t) => t.is_vip).sort(bySeq);
  const regs = waiting.filter((t) => !t.is_vip).sort(bySeq);
  const out: Ticket[] = [];
  let since = regularsSinceVip;
  while (vips.length || regs.length) {
    const preferVip = vips.length > 0 && (since >= VIP_EVERY || regs.length === 0);
    const t = preferVip ? vips.shift()! : regs.shift()!;
    out.push(t);
    since = t.is_vip ? 0 : since + 1;
  }
  return out;
}

/**
 * Who gets the "almost your turn" nudge: the next (artists + 1) waiting guests in serve order who
 * are free (not called/serving at another booth). A busy guest near the front doesn't block the
 * nudge for the guest who will actually be called next; they are nudged once they're free.
 * (Deviation from §6 "position ≤ 2": found by scripts/simulate.ts.)
 */
export function almostDue(boothTickets: readonly Ticket[], booth: Booth, busyUsers: ReadonlySet<number>): Ticket[] {
  const waiting = boothTickets.filter((t) => t.status === 'waiting');
  return orderWaiting(waiting, booth.regulars_since_vip)
    .filter((t) => !busyUsers.has(t.user_id))
    .slice(0, booth.artists + 1);
}

export interface CallResult {
  ticketId: number;
  /** true when the head of the line was skipped over because that guest is busy at another booth */
  deferredOthers: boolean;
  regularsSinceVip: number;
  patch: TicketPatch;
}

/**
 * Pick the next ticket to call at a live booth.
 * @param boothTickets every ticket at this booth (any status)
 * @param busyUsers users who currently have a called/serving ticket at another booth
 */
export function callNext(
  booth: Booth, boothTickets: readonly Ticket[], busyUsers: ReadonlySet<number>, now: number,
): CallResult | null {
  if (booth.paused) return null;
  const inProgress = boothTickets.filter((t) => isInProgress(t.status)).length;
  if (inProgress >= booth.artists) return null;

  const waiting = boothTickets.filter((t) => t.status === 'waiting');
  if (waiting.length === 0) return null;

  const vips = waiting.filter((t) => t.is_vip).sort(bySeq);
  const regs = waiting.filter((t) => !t.is_vip).sort(bySeq);
  const preferVip = vips.length > 0 && (booth.regulars_since_vip >= VIP_EVERY || regs.length === 0);
  const ordered = preferVip ? [...vips, ...regs] : [...regs, ...vips];

  // Deferred guests keep their seq, so they're first in line once they're free.
  const pick = ordered.find((t) => !busyUsers.has(t.user_id)) ?? ordered[0]; // never leave an artist idle
  return {
    ticketId: pick.id,
    deferredOthers: pick !== ordered[0],
    regularsSinceVip: pick.is_vip ? 0 : booth.regulars_since_vip + 1,
    patch: { status: 'called', called_at: now },
  };
}

/**
 * Skip a called ticket. First skip: back behind the 3rd waiting ticket (or to the end if fewer
 * than 3 are waiting). Second skip: no-show.
 */
export function skip(ticket: Ticket, boothTickets: readonly Ticket[]): TicketPatch {
  if (ticket.status !== 'called') throw new EngineError('invalid_state', `Cannot skip a ${ticket.status} ticket`);
  const skip_count = ticket.skip_count + 1;
  if (skip_count >= 2) return { status: 'no_show', skip_count };

  const behind = boothTickets
    .filter((t) => t.id !== ticket.id && t.status === 'waiting' && t.seq > ticket.seq)
    .sort(bySeq);
  let seq: number;
  if (behind.length >= 3) {
    const third = behind[2].seq;
    const fourth = behind[3]?.seq ?? third + 1;
    seq = (third + fourth) / 2;
  } else {
    seq = Math.max(...boothTickets.map((t) => t.seq), ticket.seq) + 1;
  }
  return { status: 'waiting', skip_count, seq, called_at: null };
}

export type Action = 'start' | 'done' | 'away' | 'back' | 'cancel';

const TRANSITIONS: Record<Action, { from: TicketStatus[]; to: TicketStatus }> = {
  start: { from: ['called'], to: 'serving' },
  done: { from: ['serving'], to: 'done' },
  away: { from: ['waiting'], to: 'away' },
  back: { from: ['away'], to: 'waiting' },
  cancel: { from: ['waiting', 'away', 'called'], to: 'cancelled' },
};

/** Simple state-machine moves. Throws EngineError('invalid_state') on an illegal move. */
export function transition(ticket: Ticket, action: Action, now: number): TicketPatch {
  const rule = TRANSITIONS[action];
  if (!rule.from.includes(ticket.status)) {
    throw new EngineError('invalid_state', `Cannot ${action} a ${ticket.status} ticket`);
  }
  const patch: TicketPatch = { status: rule.to };
  if (action === 'start') patch.serving_at = now;
  if (action === 'done') patch.done_at = now;
  if (action === 'away') patch.away_since = now;
  if (action === 'back') patch.away_since = null;
  return patch;
}

/** Exponential moving average of actual/base service time, clamped to [0.3, 3]. */
export function learnSpeed(speedFactor: number, servingAt: number, doneAt: number, baseMinutes: number): number {
  if (baseMinutes <= 0) return speedFactor;
  const actual = (doneAt - servingAt) / MINUTE;
  const ratio = Math.min(3, Math.max(0.3, actual / baseMinutes));
  return 0.7 * speedFactor + 0.3 * ratio;
}

/** Ticker: a called live ticket not started within 3 min gets skipped. */
export function shouldAutoSkip(t: Ticket, now: number): boolean {
  return t.status === 'called' && t.called_at !== null && now - t.called_at >= AUTO_SKIP_AFTER_MS;
}

/** Ticker: away for more than 20 min becomes a no-show. */
export function awayExpired(t: Ticket, now: number): boolean {
  return t.status === 'away' && t.away_since !== null && now - t.away_since > AWAY_TIMEOUT_MS;
}

export function formatCode(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(3, '0')}`;
}
