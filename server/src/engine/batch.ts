// Feast seating rounds (SPEC-LITE §6 "Feast rounds"). Pure.
import { Booth, EngineError, MINUTE, Round, Ticket, bySeq } from './types';

/** First-fit: VIPs first (seq order), then everyone else (seq order). A family is never split. */
export function buildRound(waiting: readonly Ticket[], seats: number): { round: Ticket[]; seatsLeft: number } {
  const ordered = [
    ...waiting.filter((t) => t.is_vip).sort(bySeq),
    ...waiting.filter((t) => !t.is_vip).sort(bySeq),
  ];
  const round: Ticket[] = [];
  let left = seats;
  for (const t of ordered) {
    if (left === 0) break;
    if (t.party_size <= left) {
      round.push(t);
      left -= t.party_size;
    }
  }
  return { round, seatsLeft: left };
}

/** Dry-run future rounds for ETA. Stops if a party can never fit (bigger than the hall). */
export function planRounds(waiting: readonly Ticket[], seats: number, maxRounds = 100): Ticket[][] {
  let remaining = [...waiting];
  const plan: Ticket[][] = [];
  while (remaining.length && plan.length < maxRounds) {
    const { round } = buildRound(remaining, seats);
    if (round.length === 0) break;
    plan.push(round);
    const ids = new Set(round.map((t) => t.id));
    remaining = remaining.filter((t) => !ids.has(t.id));
  }
  return plan;
}

export interface NextRoundResult {
  /** seating round being closed, if any */
  finishRoundId: number | null;
  /** tickets of that round → 'done' */
  finishTicketIds: number[];
  newRound: { round_no: number; started_at: number; ends_at: number };
  /** tickets seated now → 'called' with the new round id */
  seatTicketIds: number[];
  seatsLeft: number;
  /** projected next round, for the "you're in the next round" notice */
  nextUpTicketIds: number[];
}

export function startNextRound(
  booth: Booth, boothTickets: readonly Ticket[], rounds: readonly Round[], now: number,
): NextRoundResult {
  if (booth.mode !== 'batch' || !booth.round_seats || !booth.round_minutes) {
    throw new EngineError('not_batch_booth');
  }
  if (booth.paused) throw new EngineError('booth_paused');
  const current = rounds.find((r) => r.status === 'seating') ?? null;
  const lastNo = rounds.reduce((m, r) => Math.max(m, r.round_no), 0);

  const waiting = boothTickets.filter((t) => t.status === 'waiting');
  const [seated = [], nextUp = []] = planRounds(waiting, booth.round_seats, 2);
  const seatsUsed = seated.reduce((s, t) => s + t.party_size, 0);

  return {
    finishRoundId: current?.id ?? null,
    finishTicketIds: current
      ? boothTickets.filter((t) => t.round_id === current.id && (t.status === 'called' || t.status === 'serving')).map((t) => t.id)
      : [],
    newRound: { round_no: lastNo + 1, started_at: now, ends_at: now + booth.round_minutes * MINUTE },
    seatTicketIds: seated.map((t) => t.id),
    seatsLeft: booth.round_seats - seatsUsed,
    nextUpTicketIds: nextUp.map((t) => t.id),
  };
}
