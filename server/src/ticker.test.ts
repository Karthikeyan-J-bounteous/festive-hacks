// Ticker rules (SPEC-LITE §6 "Ticker") against a fresh seeded in-memory DB.
import { beforeAll, describe, expect, it } from 'vitest';
import './index'; // seeds the DB
import { db } from './db/db';
import { MINUTE } from './engine/types';
import { resetTickerState, tick } from './ticker';

const q = <T>(sql: string, ...p: (string | number)[]) => db.prepare(sql).get(...p) as T;
const boothId = (name: string) => q<{ id: number }>('SELECT id FROM booths WHERE name = ?', name).id;
const ticket = (id: number) => q<{ status: string; skip_count: number }>('SELECT status, skip_count FROM tickets WHERE id = ?', id);
const firstWaiting = (booth: string) =>
  q<{ id: number }>(`SELECT id FROM tickets WHERE booth_id = ? AND status = 'waiting' ORDER BY seq LIMIT 1`, boothId(booth)).id;

describe('ticker', () => {
  const now = Date.now();
  let firstAlmost: number[];

  beforeAll(() => {
    resetTickerState();
    firstAlmost = tick(now).almost;
  });

  it('sends "almost" once per ticket to the next free guests', () => {
    expect(firstAlmost.length).toBeGreaterThan(0);
    expect(tick(now).almost.filter((id) => firstAlmost.includes(id))).toEqual([]);
  });

  it('does not auto-skip seated feast tickets', () => {
    const seated = q<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets WHERE booth_id = ? AND status = 'called'`, boothId('Dining hall')).n;
    expect(seated).toBe(5);
  });

  it('called live ticket not started in 3 min is skipped, then no_show on the second time', () => {
    const id = firstWaiting('Nail art');
    db.prepare(`UPDATE tickets SET status = 'called', called_at = ? WHERE id = ?`).run(now - 2 * MINUTE, id);
    expect(tick(now).skipped).not.toContain(id);

    expect(tick(now + MINUTE).skipped).toContain(id);
    expect(ticket(id)).toEqual({ status: 'waiting', skip_count: 1 });

    db.prepare(`UPDATE tickets SET status = 'called', called_at = ? WHERE id = ?`).run(now - 4 * MINUTE, id);
    expect(tick(now).noShows).toContain(id);
    expect(ticket(id).status).toBe('no_show');
  });

  it('away for more than 20 min becomes no_show', () => {
    const recent = firstWaiting('Chaat counter');
    db.prepare(`UPDATE tickets SET status = 'away', away_since = ? WHERE id = ?`).run(now - 10 * MINUTE, recent);
    const old = firstWaiting('Chaat counter');
    db.prepare(`UPDATE tickets SET status = 'away', away_since = ? WHERE id = ?`).run(now - 21 * MINUTE, old);

    const r = tick(now);
    expect(r.noShows).toContain(old);
    expect(r.noShows).not.toContain(recent);
    expect(ticket(recent).status).toBe('away');
  });

  it('ended event emits a status change and cancels its open tickets', () => {
    const mehendi = q<{ id: number }>(`SELECT id FROM events WHERE type = 'mehendi'`).id;
    db.prepare(`UPDATE events SET status_override = 'ended' WHERE id = ?`).run(mehendi);

    const r = tick(now);
    expect(r.eventChanges).toContainEqual({ eventId: mehendi, live: false });
    expect(r.cancelled.length).toBeGreaterThan(0);
    const open = q<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tickets WHERE event_id = ? AND status IN ('waiting','away','called','serving')`, mehendi).n;
    expect(open).toBe(0);
  });
});
