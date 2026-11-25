// Small typed read/write helpers shared by routes. Writes must run inside a route-level tx().
import type { SQLInputValue } from 'node:sqlite';
import { db } from './db';
import type { Booth, Round, Ticket, TicketPatch } from '../engine/types';
import { isFamilyFor, type Pass, type PassEvent } from '../engine/passes';
import type { EventTiming } from '../engine/booking';
import { flag } from '../sponsors/flags';

export function one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function all<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function run(sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).run(...params);
}

export interface BoothRow extends Booth {
  event_id: number;
  wedding_id: number;
  name: string;
  code_prefix: string;
  x_pct: number;
  y_pct: number;
  options_json: string;
}
export interface TicketRow extends Ticket {
  event_id: number;
  code: string;
  option_label: string;
}
export interface EventRow extends EventTiming {
  id: number;
  wedding_id: number;
  type: string;
  name: string;
  sort_order: number;
}
export interface BoothOption { label: string; minutes: number }

const BOOTH_SELECT = `SELECT b.*, e.wedding_id FROM booths b JOIN events e ON e.id = b.event_id`;
const ACTIVE_SQL = `('waiting','away','called','serving')`;

export const getBooth = (id: number) => one<BoothRow>(`${BOOTH_SELECT} WHERE b.id = ?`, id);
export const boothsForWedding = (weddingId: number) =>
  all<BoothRow>(`${BOOTH_SELECT} WHERE e.wedding_id = ? ORDER BY b.id`, weddingId);
export const boothsForHandler = (userId: number, weddingId: number) =>
  all<BoothRow>(
    `${BOOTH_SELECT} JOIN booth_handlers h ON h.booth_id = b.id WHERE h.user_id = ? AND e.wedding_id = ? ORDER BY b.id`,
    userId, weddingId,
  );
export const boothOptions = (b: BoothRow) => JSON.parse(b.options_json) as BoothOption[];

export const getEvent = (id: number) => one<EventRow>(`SELECT * FROM events WHERE id = ?`, id);
export const getTicket = (id: number) => one<TicketRow>(`SELECT * FROM tickets WHERE id = ?`, id);

/** Every waiting/away/called/serving ticket at a booth. */
/**
 * Open tickets at a booth in seq order. With the Flagsmith `family_passes` flag off the VIP lane is off:
 * every row reads as regular, so call order, ETAs and the handler queue all ignore passes.
 */
export function activeTickets(boothId: number): TicketRow[] {
  const rows = all<TicketRow>(`SELECT * FROM tickets WHERE booth_id = ? AND status IN ${ACTIVE_SQL} ORDER BY seq`, boothId);
  return flag('family_passes') ? rows : rows.map((t) => ({ ...t, is_vip: 0 }));
}

/** Users with a called/serving ticket at some other booth (for conflict deferral). */
export function busyUsersElsewhere(boothId: number): Set<number> {
  const rows = all<{ user_id: number }>(
    `SELECT DISTINCT user_id FROM tickets WHERE booth_id != ? AND status IN ('called','serving')`, boothId);
  return new Set(rows.map((r) => r.user_id));
}

export const seatingRound = (boothId: number) =>
  one<Round>(`SELECT * FROM rounds WHERE booth_id = ? AND status = 'seating'`, boothId) ?? null;
export const boothRounds = (boothId: number) => all<Round>(`SELECT * FROM rounds WHERE booth_id = ?`, boothId);

/** Passes this user has claimed in a wedding (revoked included) plus their event links, in engine shape. */
export function passesForUser(userId: number, weddingId: number): { passes: Pass[]; passEvents: PassEvent[] } {
  const passes = all<Pass>(
    `SELECT id, side, claimed_by_user_id, revoked_at FROM family_passes WHERE wedding_id = ? AND claimed_by_user_id = ?`,
    weddingId, userId);
  const passEvents = passes.length
    ? all<PassEvent>(`SELECT pass_id, event_id FROM pass_events WHERE pass_id IN (${passes.map(() => '?').join(',')})`,
      ...passes.map((p) => p.id))
    : [];
  return { passes, passEvents };
}

/**
 * Recompute the cached `is_vip` on a user's queued (waiting/away) tickets after a pass claim or revoke.
 * Returns the changed ticket ids grouped by booth, for socket emits after commit. Call inside tx().
 */
export function refreshVip(userId: number, weddingId: number): Map<number, number[]> {
  const { passes, passEvents } = passesForUser(userId, weddingId);
  const queued = all<TicketRow>(
    `SELECT t.* FROM tickets t JOIN events e ON e.id = t.event_id
     WHERE t.user_id = ? AND e.wedding_id = ? AND t.status IN ('waiting','away')`, userId, weddingId);
  const changed = new Map<number, number[]>();
  for (const t of queued) {
    const vip = isFamilyFor(userId, t.event_id, passes, passEvents) ? 1 : 0;
    if (Number(t.is_vip) === vip) continue;
    run(`UPDATE tickets SET is_vip = ? WHERE id = ?`, vip, t.id);
    changed.set(t.booth_id, [...(changed.get(t.booth_id) ?? []), t.id]);
  }
  return changed;
}

export function hasPresence(userId: number, weddingId: number, now: number): boolean {
  const p = one<{ valid_until: number }>(`SELECT valid_until FROM presence WHERE user_id = ? AND wedding_id = ?`, userId, weddingId);
  return !!p && p.valid_until > now;
}

const PATCH_COLUMNS = new Set(['status', 'seq', 'skip_count', 'called_at', 'serving_at', 'done_at', 'away_since', 'is_vip', 'round_id']);

/** Write an engine TicketPatch back to the row. */
export function applyPatch(ticketId: number, patch: TicketPatch): void {
  const keys = Object.keys(patch).filter((k) => PATCH_COLUMNS.has(k)) as (keyof TicketPatch)[];
  if (keys.length === 0) return;
  run(`UPDATE tickets SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    ...keys.map((k) => (patch[k] ?? null) as SQLInputValue), ticketId);
}
