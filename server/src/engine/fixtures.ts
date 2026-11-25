// Test helpers for engine suites (not used at runtime).
import { Booth, Ticket } from './types';

let nextId = 1;

export function mkTicket(p: Partial<Ticket> = {}): Ticket {
  const id = p.id ?? nextId++;
  return {
    id,
    booth_id: 1,
    user_id: id + 1000,
    status: 'waiting',
    seq: id,
    is_vip: 0,
    skip_count: 0,
    base_minutes: 15,
    party_size: 1,
    joined_at: 0,
    called_at: null,
    serving_at: null,
    done_at: null,
    away_since: null,
    round_id: null,
    ...p,
  };
}

export function mkBooth(p: Partial<Booth> = {}): Booth {
  return {
    id: 1,
    mode: 'live',
    service_type: 'mehendi',
    artists: 1,
    paused: 0,
    speed_factor: 1,
    regulars_since_vip: 0,
    round_seats: null,
    round_minutes: null,
    ...p,
  };
}
