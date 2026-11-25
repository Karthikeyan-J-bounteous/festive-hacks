// ETA (SPEC-LITE §6 "ETA", deliberately simple). Pure.
import { planRounds } from './batch';
import { orderWaiting } from './live';
import { Booth, MINUTE, Round, Ticket, isInProgress } from './types';

export interface Eta {
  /** 1-based place in line (live) or round number from now (batch) */
  position: number;
  ahead: number;
  minutes: number;
  low: number;
  high: number;
}

const down5 = (m: number) => Math.max(0, Math.round(m / 5) * 5);
const up5 = (m: number) => Math.max(0, Math.ceil(m / 5) * 5);

function range(minutes: number): Pick<Eta, 'low' | 'high'> {
  const low = down5(minutes);
  return { low, high: Math.max(low, up5(minutes * 1.3)) };
}

function avgBase(tickets: readonly Ticket[]): number {
  if (tickets.length === 0) return 0;
  return tickets.reduce((s, t) => s + t.base_minutes, 0) / tickets.length;
}

/**
 * Live booths. `ahead` = guests in progress at the booth + waiting guests served before me
 * (VIP ratio applied). minutes = ceil(ahead / artists) * avgBaseMinutes * speed_factor.
 */
export function liveEta(ticketId: number, boothTickets: readonly Ticket[], booth: Booth): Eta | null {
  const order = orderWaiting(boothTickets.filter((t) => t.status === 'waiting'), booth.regulars_since_vip);
  const idx = order.findIndex((t) => t.id === ticketId);
  if (idx < 0) return null;
  const inProgress = boothTickets.filter((t) => isInProgress(t.status));
  const aheadTickets = [...inProgress, ...order.slice(0, idx)];
  const ahead = aheadTickets.length;
  const minutes = Math.ceil(ahead / Math.max(1, booth.artists)) * avgBase(aheadTickets) * booth.speed_factor;
  return { position: idx + 1, ahead, minutes, ...range(minutes) };
}

/** Wait estimate for someone joining the back of a live line now (booth badge colour). */
export function liveBoothWait(boothTickets: readonly Ticket[], booth: Booth): number {
  const active = boothTickets.filter((t) => t.status === 'waiting' || isInProgress(t.status));
  return Math.ceil(active.length / Math.max(1, booth.artists)) * avgBase(active) * booth.speed_factor;
}

/**
 * Feast booths: dry-run future rounds; my round r (1-based) starts after the current round ends
 * plus (r-1) full rounds.
 */
export function batchEta(
  ticketId: number, boothTickets: readonly Ticket[], booth: Booth, currentRound: Round | null, now: number,
): Eta | null {
  if (!booth.round_seats || !booth.round_minutes) return null;
  const waiting = boothTickets.filter((t) => t.status === 'waiting');
  const plan = planRounds(waiting, booth.round_seats);
  const r = plan.findIndex((round) => round.some((t) => t.id === ticketId));
  if (r < 0) return null;
  const leftInCurrent = currentRound ? Math.max(0, Math.ceil((currentRound.ends_at - now) / MINUTE)) : 0;
  const minutes = r * booth.round_minutes + leftInCurrent;
  const ahead = plan.slice(0, r).reduce((n, round) => n + round.length, 0);
  return { position: r + 1, ahead, minutes, ...range(minutes) };
}

export type WaitColour = 'green' | 'amber' | 'red' | 'grey';
export function waitColour(minutes: number, paused: boolean): WaitColour {
  if (paused) return 'grey';
  if (minutes < 10) return 'green';
  if (minutes <= 25) return 'amber';
  return 'red';
}
