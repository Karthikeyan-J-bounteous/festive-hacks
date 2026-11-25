// JSON shapes shared by guest and booth routes. Read-only.
import { batchEta, liveEta, liveBoothWait, waitColour, Eta } from '../engine/eta';
import { orderWaiting } from '../engine/live';
import { Ticket, isInProgress } from '../engine/types';
import { BoothRow, TicketRow, activeTickets, boothOptions, seatingRound } from '../db/queries';
import { flag } from '../sponsors/flags';

export function ticketEta(t: TicketRow, booth: BoothRow, boothTickets: readonly TicketRow[], now: number): Eta | null {
  if (t.status !== 'waiting') return null;
  return booth.mode === 'live'
    ? liveEta(t.id, boothTickets, booth)
    : batchEta(t.id, boothTickets, booth, seatingRound(booth.id), now);
}

export function ticketView(t: TicketRow, booth: BoothRow, boothTickets: readonly TicketRow[], now: number) {
  return {
    id: t.id,
    boothId: t.booth_id,
    boothName: booth.name,
    eventId: t.event_id,
    code: t.code,
    option: t.option_label,
    partySize: t.party_size,
    status: t.status,
    isVip: !!t.is_vip && flag('family_passes'),
    skipCount: t.skip_count,
    roundId: t.round_id,
    joinedAt: t.joined_at,
    calledAt: t.called_at,
    servingAt: t.serving_at,
    eta: ticketEta(t, booth, boothTickets, now),
  };
}

/** Wait (minutes) for someone joining the back of the line now. */
function joinWait(booth: BoothRow, tickets: readonly TicketRow[], now: number): number {
  if (booth.mode === 'live') return liveBoothWait(tickets, booth);
  const probe: Ticket = {
    id: -1, booth_id: booth.id, user_id: -1, status: 'waiting', seq: Number.MAX_SAFE_INTEGER, is_vip: 0,
    skip_count: 0, base_minutes: 0, party_size: 1, joined_at: now, called_at: null, serving_at: null,
    done_at: null, away_since: null, round_id: null,
  };
  return batchEta(-1, [...tickets, probe], booth, seatingRound(booth.id), now)?.minutes ?? 0;
}

export function boothView(booth: BoothRow, now: number, tickets: readonly TicketRow[] = activeTickets(booth.id)) {
  const waitMin = Math.round(joinWait(booth, tickets, now));
  return {
    id: booth.id,
    eventId: booth.event_id,
    name: booth.name,
    serviceType: booth.service_type,
    mode: booth.mode,
    x: booth.x_pct,
    y: booth.y_pct,
    options: boothOptions(booth),
    artists: booth.artists,
    paused: !!booth.paused,
    roundSeats: booth.round_seats,
    roundMinutes: booth.round_minutes,
    waiting: tickets.filter((t) => t.status === 'waiting').length,
    inProgress: tickets.filter((t) => isInProgress(t.status)).length,
    waitMin,
    colour: waitColour(waitMin, !!booth.paused),
  };
}

/** Handler console: booth summary + its queue in serve order (in progress first). */
export function boothState(booth: BoothRow, now: number, names: ReadonlyMap<number, string | null>) {
  const tickets = activeTickets(booth.id);
  const waiting = tickets.filter((t) => t.status === 'waiting');
  const ordered = [
    ...tickets.filter((t) => isInProgress(t.status)),
    ...(booth.mode === 'live' ? orderWaiting(waiting, booth.regulars_since_vip) as TicketRow[] : waiting),
    ...tickets.filter((t) => t.status === 'away'),
  ];
  const round = booth.mode === 'batch' ? seatingRound(booth.id) : null;
  return {
    ...boothView(booth, now, tickets),
    speedFactor: booth.speed_factor,
    round: round && {
      id: round.id,
      roundNo: round.round_no,
      startedAt: round.started_at,
      endsAt: round.ends_at,
      seatsUsed: tickets.filter((t) => t.round_id === round.id).reduce((s, t) => s + t.party_size, 0),
    },
    queue: ordered.map((t) => ({ ...ticketView(t, booth, tickets, now), guestName: names.get(t.user_id) ?? null })),
  };
}
