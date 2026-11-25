import { describe, expect, it } from 'vitest';
import { batchEta, liveBoothWait, liveEta, waitColour } from './eta';
import { mkBooth, mkTicket } from './fixtures';
import { MINUTE, Round } from './types';

describe('liveEta', () => {
  it('is monotonic along the queue', () => {
    const booth = mkBooth({ artists: 2, speed_factor: 1.2 });
    const ts = [1, 2, 3, 4, 5, 6, 7].map((id) => mkTicket({ id, seq: id, base_minutes: 10 + id }));
    const minutes = ts.map((t) => liveEta(t.id, ts, booth)!.minutes);
    for (let i = 1; i < minutes.length; i++) expect(minutes[i]).toBeGreaterThanOrEqual(minutes[i - 1]);
    expect(ts.map((t) => liveEta(t.id, ts, booth)!.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('first in line waits 0 when an artist is free', () => {
    const ts = [mkTicket({ id: 1 })];
    expect(liveEta(1, ts, mkBooth())).toMatchObject({ position: 1, ahead: 0, minutes: 0, low: 0, high: 0 });
  });

  it('counts guests already being served', () => {
    const booth = mkBooth({ artists: 2 });
    const ts = [
      mkTicket({ id: 1, status: 'serving', base_minutes: 20 }),
      mkTicket({ id: 2, status: 'called', base_minutes: 20 }),
      mkTicket({ id: 3, base_minutes: 20 }),
    ];
    expect(liveEta(3, ts, booth)).toMatchObject({ position: 1, ahead: 2, minutes: 20, low: 20, high: 30 });
  });

  it('uses the VIP order for VIPs', () => {
    const booth = mkBooth({ regulars_since_vip: 3 });
    const ts = [mkTicket({ id: 1, seq: 1 }), mkTicket({ id: 2, seq: 2 }), mkTicket({ id: 3, seq: 3, is_vip: 1 })];
    expect(liveEta(3, ts, booth)!.position).toBe(1);
    expect(liveEta(1, ts, booth)!.position).toBe(2);
  });

  it('returns null for a ticket not waiting', () => {
    expect(liveEta(1, [mkTicket({ id: 1, status: 'called' })], mkBooth())).toBeNull();
  });

  it('booth wait for a newcomer grows with the line', () => {
    const booth = mkBooth();
    expect(liveBoothWait([], booth)).toBe(0);
    expect(liveBoothWait([mkTicket(), mkTicket()], booth)).toBe(30);
  });
});

describe('batchEta', () => {
  const booth = mkBooth({ mode: 'batch', service_type: 'feast', round_seats: 10, round_minutes: 25 });
  const current: Round = { id: 9, booth_id: 1, round_no: 4, status: 'seating', started_at: 0, ends_at: 10 * MINUTE };

  it('places parties in future rounds after the current round ends', () => {
    const ts = [
      mkTicket({ id: 1, seq: 1, party_size: 4 }),
      mkTicket({ id: 2, seq: 2, party_size: 4 }),
      mkTicket({ id: 3, seq: 3, party_size: 4 }),
    ];
    expect(batchEta(1, ts, booth, current, 0)).toMatchObject({ position: 1, minutes: 10 });
    expect(batchEta(3, ts, booth, current, 0)).toMatchObject({ position: 2, ahead: 2, minutes: 35 });
  });

  it('starts from now when no round is seating', () => {
    expect(batchEta(1, [mkTicket({ id: 1, party_size: 2 })], booth, null, 0)!.minutes).toBe(0);
  });

  it('is monotonic in seq for equal party sizes', () => {
    const ts = Array.from({ length: 12 }, (_, i) => mkTicket({ id: i + 1, seq: i + 1, party_size: 3 }));
    const mins = ts.map((t) => batchEta(t.id, ts, booth, current, 0)!.minutes);
    for (let i = 1; i < mins.length; i++) expect(mins[i]).toBeGreaterThanOrEqual(mins[i - 1]);
  });
});

it.each([
  [5, false, 'green'], [10, false, 'amber'], [25, false, 'amber'], [26, false, 'red'], [5, true, 'grey'],
] as const)('wait %d min (paused=%s) is %s', (m, paused, colour) => {
  expect(waitColour(m, paused)).toBe(colour);
});
