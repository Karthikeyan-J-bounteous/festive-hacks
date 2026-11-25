import { describe, expect, it } from 'vitest';
import { Pass, PassEvent, QuotaExceeded, assertQuota, checkClaim, generateToken, isFamilyFor, usedByEvent } from './passes';

const pass = (p: Partial<Pass> & { id: number }): Pass => ({ side: 'bride', claimed_by_user_id: null, revoked_at: null, ...p });

describe('quota', () => {
  const passes: Pass[] = [
    pass({ id: 1 }), pass({ id: 2 }), pass({ id: 3, side: 'groom' }), pass({ id: 4, revoked_at: 5 }),
  ];
  const pe: PassEvent[] = [
    { pass_id: 1, event_id: 10 }, { pass_id: 1, event_id: 20 },
    { pass_id: 2, event_id: 10 }, { pass_id: 3, event_id: 10 }, { pass_id: 4, event_id: 20 },
  ];

  it('counts unrevoked passes per event for one side', () => {
    expect(Object.fromEntries(usedByEvent(passes, pe, 'bride'))).toEqual({ 10: 2, 20: 1 });
    expect(Object.fromEntries(usedByEvent(passes, pe, 'groom'))).toEqual({ 10: 1 });
  });

  it('rejects the 41st bride pass', () => {
    expect(() => assertQuota([10], new Map([[10, 40]]), new Map([[10, 40]]))).toThrow(QuotaExceeded);
    expect(() => assertQuota([10], new Map([[10, 39]]), new Map([[10, 40]]))).not.toThrow();
  });

  it('is all-or-nothing and names the full event', () => {
    const used = new Map([[10, 1], [20, 5]]);
    const limits = new Map([[10, 40], [20, 5]]);
    try {
      assertQuota([10, 20], used, limits);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(QuotaExceeded);
      expect(e).toMatchObject({ code: 'quota_exceeded', eventId: 20, used: 5, limit: 5 });
    }
  });

  it('treats a missing quota row as 0', () => {
    expect(() => assertQuota([99], new Map(), new Map())).toThrow(QuotaExceeded);
  });

  it('revoking a pass frees its quota', () => {
    const limits = new Map([[10, 2]]);
    expect(() => assertQuota([10], usedByEvent(passes, pe, 'bride'), limits)).toThrow(QuotaExceeded);
    const afterRevoke = passes.map((p) => (p.id === 2 ? { ...p, revoked_at: 9 } : p));
    expect(() => assertQuota([10], usedByEvent(afterRevoke, pe, 'bride'), limits)).not.toThrow();
  });
});

describe('checkClaim', () => {
  it.each([
    ['unclaimed pass', pass({ id: 1 }), false, 'claim'],
    ['same user again (idempotent)', pass({ id: 1, claimed_by_user_id: 7 }), false, 'already_mine'],
  ] as const)('%s', (_n, p, other, outcome) => {
    expect(checkClaim(p, 7, other)).toBe(outcome);
  });

  it.each([
    ['missing pass', undefined, false, 'pass_invalid'],
    ['revoked pass', pass({ id: 1, revoked_at: 1 }), false, 'pass_invalid'],
    ['claimed by someone else', pass({ id: 1, claimed_by_user_id: 8 }), false, 'already_claimed'],
    ['user already has a pass', pass({ id: 1 }), true, 'already_have_pass'],
  ] as const)('rejects %s', (_n, p, other, code) => {
    let caught: unknown;
    try { checkClaim(p, 7, other); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code });
  });
});

describe('isFamilyFor', () => {
  const pe: PassEvent[] = [{ pass_id: 1, event_id: 10 }];
  it.each([
    ['claimed pass covering the event', pass({ id: 1, claimed_by_user_id: 7 }), 10, true],
    ['event not covered', pass({ id: 1, claimed_by_user_id: 7 }), 20, false],
    ['revoked pass', pass({ id: 1, claimed_by_user_id: 7, revoked_at: 1 }), 10, false],
    ['someone else\'s pass', pass({ id: 1, claimed_by_user_id: 8 }), 10, false],
  ] as const)('%s → %s', (_n, p, eventId, expected) => {
    expect(isFamilyFor(7, eventId, [p], pe)).toBe(expected);
  });
});

it('generates unguessable URL-safe tokens', () => {
  const a = generateToken();
  expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(generateToken()).not.toBe(a);
});
