// Booking rules (SPEC-LITE §6 "Booking rules" + "Event live"). Pure.
import { MINUTE } from './types';

export const MAX_ACTIVE_PER_EVENT = 3;
export const GROUP_SERVICES: ReadonlySet<string> = new Set(['blessing', 'feast']);
export const MAX_PARTY = 12;

export interface EventTiming {
  starts_at: number;
  ends_at: number;
  status_override: 'auto' | 'live' | 'ended';
}

export function isLive(e: EventTiming, now: number): boolean {
  if (e.status_override === 'live') return true;
  if (e.status_override === 'ended') return false;
  return e.starts_at - 30 * MINUTE <= now && now < e.ends_at;
}

/** Over for good: forced ended, or past its end time while on auto. Its open tickets get cancelled. */
export function isEnded(e: EventTiming, now: number): boolean {
  if (e.status_override === 'ended') return true;
  return e.status_override === 'auto' && now >= e.ends_at;
}

export type JoinError =
  | 'event_not_live' | 'booth_paused' | 'presence_required'
  | 'duplicate' | 'max_tickets' | 'bad_party_size' | 'bad_option';

export interface JoinContext {
  eventLive: boolean;
  boothPaused: boolean;
  presenceValid: boolean;
  hasActiveAtBooth: boolean;
  activeInEvent: number;
  serviceType: string;
  partySize: number;
  optionValid: boolean;
}

/** Returns the first rule a join breaks, or null if the join is allowed. */
export function checkJoin(c: JoinContext): JoinError | null {
  if (!c.eventLive) return 'event_not_live';
  if (c.boothPaused) return 'booth_paused';
  if (!c.presenceValid) return 'presence_required';
  if (c.hasActiveAtBooth) return 'duplicate';
  if (c.activeInEvent >= MAX_ACTIVE_PER_EVENT) return 'max_tickets';
  if (!c.optionValid) return 'bad_option';
  const maxParty = GROUP_SERVICES.has(c.serviceType) ? MAX_PARTY : 1;
  if (!Number.isInteger(c.partySize) || c.partySize < 1 || c.partySize > maxParty) return 'bad_party_size';
  return null;
}

/** HTTP status for each join error, so routes stay consistent. */
export const JOIN_ERROR_STATUS: Record<JoinError, number> = {
  event_not_live: 409,
  booth_paused: 409,
  presence_required: 403,
  duplicate: 409,
  max_tickets: 409,
  bad_party_size: 400,
  bad_option: 400,
};
