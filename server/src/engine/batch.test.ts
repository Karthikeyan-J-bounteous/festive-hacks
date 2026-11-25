import { describe, expect, it } from 'vitest';
import { buildRound, planRounds, startNextRound } from './batch';
import { mkBooth, mkTicket } from './fixtures';
import { MINUTE, Round } from './types';

const ids = (ts: { id: number }[]) => ts.map((t) => t.id);

describe('buildRound', () => {
  it('first-fit: skips a family that does not fit and seats smaller ones behind it', () => {
    const ts = [
      mkTicket({ id: 1, seq: 1, party_size: 6 }),
      mkTicket({ id: 2, seq: 2, party_size: 5 }),
      mkTicket({ id: 3, seq: 3, party_size: 3 }),
    ];
    const { round, seatsLeft } = buildRound(ts, 10);
    expect(ids(round)).toEqual([1, 3]);
    expect(seatsLeft).toBe(1);
  });

  it('never splits a family', () => {
    const { round } = buildRound([mkTicket({ id: 1, party_size: 12 })], 10);
    expect(round).toEqual([]);
  });

  it('seats VIP families first', () => {
    const ts = [
      mkTicket({ id: 1, seq: 1, party_size: 6 }),
      mkTicket({ id: 2, seq: 2, party_size: 6, is_vip: 1 }),
    ];
    expect(ids(buildRound(ts, 10).round)).toEqual([2]);
  });

  it('stops when the hall is full', () => {
    const ts = [mkTicket({ id: 1, party_size: 5 }), mkTicket({ id: 2, party_size: 5 }), mkTicket({ id: 3, party_size: 1 })];
    expect(buildRound(ts, 10)).toMatchObject({ seatsLeft: 0 });
    expect(ids(buildRound(ts, 10).round)).toEqual([1, 2]);
  });
});

describe('planRounds', () => {
  it('splits the queue into rounds', () => {
    const ts = [1, 2, 3, 4].map((id) => mkTicket({ id, seq: id, party_size: 4 }));
    expect(planRounds(ts, 10).map(ids)).toEqual([[1, 2], [3, 4]]);
  });

  it('stops on a party bigger than the hall instead of looping', () => {
    const ts = [mkTicket({ id: 1, party_size: 2 }), mkTicket({ id: 2, party_size: 50 })];
    expect(planRounds(ts, 10).map(ids)).toEqual([[1]]);
  });
});

describe('startNextRound', () => {
  const booth = mkBooth({ id: 1, mode: 'batch', service_type: 'feast', round_seats: 10, round_minutes: 25 });
  const rounds: Round[] = [
    { id: 1, booth_id: 1, round_no: 1, status: 'done', started_at: 0, ends_at: 1 },
    { id: 2, booth_id: 1, round_no: 2, status: 'seating', started_at: 1, ends_at: 2 },
  ];

  it('closes the seating round, seats the next one and names who is next up', () => {
    const ts = [
      mkTicket({ id: 1, status: 'called', round_id: 2, party_size: 4 }),
      mkTicket({ id: 2, seq: 2, party_size: 6 }),
      mkTicket({ id: 3, seq: 3, party_size: 3 }),
      mkTicket({ id: 4, seq: 4, party_size: 4 }),
      mkTicket({ id: 5, seq: 5, party_size: 9 }),
    ];
    const r = startNextRound(booth, ts, rounds, 1000);
    expect(r).toEqual({
      finishRoundId: 2,
      finishTicketIds: [1],
      newRound: { round_no: 3, started_at: 1000, ends_at: 1000 + 25 * MINUTE },
      seatTicketIds: [2, 3],
      seatsLeft: 1,
      nextUpTicketIds: [4],
    });
  });

  it('works for the very first round', () => {
    const r = startNextRound(booth, [mkTicket({ id: 7, party_size: 2 })], [], 0);
    expect(r).toMatchObject({ finishRoundId: null, finishTicketIds: [], newRound: { round_no: 1 }, seatTicketIds: [7] });
  });

  it('with nobody waiting, closes the current round without opening an empty one', () => {
    const r = startNextRound(booth, [mkTicket({ id: 1, status: 'called', round_id: 2 })], rounds, 1000);
    expect(r).toMatchObject({ finishRoundId: 2, finishTicketIds: [1], newRound: null, seatTicketIds: [] });
  });

  it('with nobody waiting and no round seating, refuses', () => {
    expect(() => startNextRound(booth, [], rounds.slice(0, 1), 0)).toThrow('Nobody is waiting');
  });

  it('rejects live booths and paused booths', () => {
    expect(() => startNextRound(mkBooth(), [], [], 0)).toThrow('not_batch_booth');
    expect(() => startNextRound({ ...booth, paused: 1 }, [], [], 0)).toThrow('booth_paused');
  });
});
