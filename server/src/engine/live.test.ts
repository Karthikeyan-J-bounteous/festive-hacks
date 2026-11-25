import { describe, expect, it } from 'vitest';
import { mkBooth, mkTicket } from './fixtures';
import { Action, awayExpired, callNext, formatCode, learnSpeed, shouldAutoSkip, skip, transition } from './live';
import { Booth, MINUTE, Ticket, TicketStatus } from './types';

const NONE = new Set<number>();

/** Call repeatedly, finishing each called ticket, and return the serving order. */
function drain(booth: Booth, tickets: Ticket[]): number[] {
  const order: number[] = [];
  let b = { ...booth };
  let ts = tickets.map((t) => ({ ...t }));
  for (;;) {
    const r = callNext(b, ts, NONE, 0);
    if (!r) return order;
    order.push(r.ticketId);
    b = { ...b, regulars_since_vip: r.regularsSinceVip };
    ts = ts.map((t) => (t.id === r.ticketId ? { ...t, status: 'done' as TicketStatus } : t));
  }
}

describe('callNext', () => {
  it('serves regulars first-in first-out', () => {
    const ts = [mkTicket({ id: 3, seq: 3 }), mkTicket({ id: 1, seq: 1 }), mkTicket({ id: 2, seq: 2 })];
    expect(drain(mkBooth(), ts)).toEqual([1, 2, 3]);
  });

  it('lets one VIP in after every 3 regulars', () => {
    const regs = [1, 2, 3, 4, 5, 6, 7].map((id) => mkTicket({ id, seq: id }));
    const vips = [8, 9].map((id) => mkTicket({ id, seq: id, is_vip: 1 }));
    expect(drain(mkBooth(), [...regs, ...vips])).toEqual([1, 2, 3, 8, 4, 5, 6, 9, 7]);
  });

  it('serves a VIP straight away when no regulars are waiting', () => {
    expect(callNext(mkBooth(), [mkTicket({ id: 1, is_vip: 1 })], NONE, 0)?.ticketId).toBe(1);
  });

  it('updates the VIP counter', () => {
    const booth = mkBooth({ regulars_since_vip: 3 });
    const vip = callNext(booth, [mkTicket({ id: 1 }), mkTicket({ id: 2, is_vip: 1 })], NONE, 0)!;
    expect(vip).toMatchObject({ ticketId: 2, regularsSinceVip: 0 });
    const reg = callNext(mkBooth({ regulars_since_vip: 1 }), [mkTicket({ id: 1 })], NONE, 0)!;
    expect(reg.regularsSinceVip).toBe(2);
  });

  it('defers a guest who is busy at another booth, keeping their seq', () => {
    const ts = [mkTicket({ id: 1, seq: 1, user_id: 50 }), mkTicket({ id: 2, seq: 2, user_id: 51 })];
    const r = callNext(mkBooth(), ts, new Set([50]), 123)!;
    expect(r).toMatchObject({ ticketId: 2, deferredOthers: true, patch: { status: 'called', called_at: 123 } });
  });

  it('never leaves an artist idle: falls back to the head when everyone is busy', () => {
    const ts = [mkTicket({ id: 1, user_id: 50 }), mkTicket({ id: 2, user_id: 51 })];
    expect(callNext(mkBooth(), ts, new Set([50, 51]), 0)).toMatchObject({ ticketId: 1, deferredOthers: false });
  });

  it('calls in parallel up to the number of artists', () => {
    const booth = mkBooth({ artists: 2 });
    const one = [mkTicket({ id: 1, status: 'serving' }), mkTicket({ id: 2 })];
    expect(callNext(booth, one, NONE, 0)?.ticketId).toBe(2);
    const two = [mkTicket({ id: 1, status: 'serving' }), mkTicket({ id: 2, status: 'called' }), mkTicket({ id: 3 })];
    expect(callNext(booth, two, NONE, 0)).toBeNull();
  });

  it.each([
    ['paused booth', mkBooth({ paused: 1 }), [mkTicket()]],
    ['empty queue', mkBooth(), []],
    ['only away guests', mkBooth(), [mkTicket({ status: 'away' })]],
  ])('returns null for %s', (_name, booth, ts) => {
    expect(callNext(booth, ts, NONE, 0)).toBeNull();
  });
});

describe('skip', () => {
  const queue = () => [
    mkTicket({ id: 1, seq: 1, status: 'called', called_at: 5 }),
    mkTicket({ id: 2, seq: 2 }), mkTicket({ id: 3, seq: 3 }), mkTicket({ id: 4, seq: 4 }), mkTicket({ id: 5, seq: 5 }),
  ];

  it('first skip moves the guest back behind 3 waiting guests', () => {
    const ts = queue();
    const patch = skip(ts[0], ts);
    expect(patch).toEqual({ status: 'waiting', skip_count: 1, seq: 4.5, called_at: null });
  });

  it('first skip goes to the end when fewer than 3 are behind', () => {
    const ts = queue().slice(0, 3);
    expect(skip(ts[0], ts).seq).toBe(4);
  });

  it('second skip is a no-show', () => {
    const t = mkTicket({ status: 'called', skip_count: 1 });
    expect(skip(t, [t])).toEqual({ status: 'no_show', skip_count: 2 });
  });

  it('only a called ticket can be skipped', () => {
    const t = mkTicket({ status: 'waiting' });
    expect(() => skip(t, [t])).toThrow(/Cannot skip/);
  });
});

describe('transition', () => {
  it.each<[Action, TicketStatus, TicketStatus, object]>([
    ['start', 'called', 'serving', { serving_at: 9 }],
    ['done', 'serving', 'done', { done_at: 9 }],
    ['away', 'waiting', 'away', { away_since: 9 }],
    ['back', 'away', 'waiting', { away_since: null }],
    ['cancel', 'waiting', 'cancelled', {}],
    ['cancel', 'away', 'cancelled', {}],
    ['cancel', 'called', 'cancelled', {}],
  ])('%s: %s → %s', (action, from, to, extra) => {
    expect(transition(mkTicket({ status: from }), action, 9)).toEqual({ status: to, ...extra });
  });

  it.each<[Action, TicketStatus]>([
    ['start', 'waiting'], ['done', 'called'], ['away', 'called'], ['back', 'waiting'], ['cancel', 'serving'], ['cancel', 'done'],
  ])('rejects %s from %s', (action, from) => {
    expect(() => transition(mkTicket({ status: from }), action, 0)).toThrow(/Cannot/);
  });
});

describe('learnSpeed', () => {
  it.each([
    ['twice as slow', 30, 15, 0.7 + 0.3 * 2],
    ['exactly on time', 15, 15, 1],
    ['clamped at 3x', 100, 10, 0.7 + 0.3 * 3],
    ['clamped at 0.3x', 1, 15, 0.7 + 0.3 * 0.3],
  ])('%s', (_n, actualMin, base, expected) => {
    expect(learnSpeed(1, 0, actualMin * MINUTE, base)).toBeCloseTo(expected);
  });
});

describe('ticker rules', () => {
  it('auto-skips a called ticket after 3 minutes', () => {
    const t = mkTicket({ status: 'called', called_at: 0 });
    expect(shouldAutoSkip(t, 3 * MINUTE - 1)).toBe(false);
    expect(shouldAutoSkip(t, 3 * MINUTE)).toBe(true);
  });

  it('turns away > 20 min into a no-show', () => {
    const t = mkTicket({ status: 'away', away_since: 0 });
    expect(awayExpired(t, 20 * MINUTE)).toBe(false);
    expect(awayExpired(t, 20 * MINUTE + 1)).toBe(true);
  });
});

it('formats ticket codes', () => {
  expect(formatCode('M', 14)).toBe('M-014');
});
