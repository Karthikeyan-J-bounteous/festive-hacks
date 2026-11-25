// Shared engine types. Field names mirror DB columns so route code can pass rows straight in.
// Booleans are 0/1 numbers, as node:sqlite returns them.

export const MINUTE = 60_000;

export type TicketStatus = 'waiting' | 'away' | 'called' | 'serving' | 'done' | 'no_show' | 'cancelled';
export const ACTIVE_STATUSES: readonly TicketStatus[] = ['waiting', 'away', 'called', 'serving'];
export const IN_PROGRESS_STATUSES: readonly TicketStatus[] = ['called', 'serving'];

export interface Ticket {
  id: number;
  booth_id: number;
  user_id: number;
  status: TicketStatus;
  seq: number;
  is_vip: number;
  skip_count: number;
  base_minutes: number;
  party_size: number;
  joined_at: number;
  called_at: number | null;
  serving_at: number | null;
  done_at: number | null;
  away_since: number | null;
  round_id: number | null;
}

export interface Booth {
  id: number;
  mode: 'live' | 'batch';
  service_type: string;
  artists: number;
  paused: number;
  speed_factor: number;
  regulars_since_vip: number;
  round_seats: number | null;
  round_minutes: number | null;
}

export interface Round {
  id: number;
  booth_id: number;
  round_no: number;
  status: 'seating' | 'done';
  started_at: number;
  ends_at: number;
}

/** A partial ticket update the route layer writes back to the DB. */
export type TicketPatch = Partial<Pick<Ticket,
  'status' | 'seq' | 'skip_count' | 'called_at' | 'serving_at' | 'done_at' | 'away_since' | 'is_vip' | 'round_id'>>;

/** Domain error. `code` is sent to the client as `{ error: code }`. */
export class EngineError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'EngineError';
  }
}

export const bySeq = (a: Pick<Ticket, 'seq'>, b: Pick<Ticket, 'seq'>) => a.seq - b.seq;
export const isActive = (s: TicketStatus) => ACTIVE_STATUSES.includes(s);
export const isInProgress = (s: TicketStatus) => IN_PROGRESS_STATUSES.includes(s);
