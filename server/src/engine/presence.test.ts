import { describe, expect, it } from 'vitest';
import { CODE_WINDOW_MS, checkGeo, currentCode, haversineMeters, verifyCode } from './presence';

const venue = { lat: 13.0827, lng: 80.2707 };
/** A point `m` metres due north of the venue. */
const north = (m: number) => ({ lat: venue.lat + m / 111_195, lng: venue.lng });

describe('geofence', () => {
  it('measures distance', () => {
    expect(haversineMeters(venue, north(200))).toBeCloseTo(200, 0);
  });

  it.each([
    ['inside the radius', 100, 10, { ok: true }],
    ['200 m away, accuracy 60 → 140 ≤ 150', 200, 60, { ok: true }],
    ['200 m away, accuracy 20 → 180 > 150', 200, 20, { ok: false, reason: 'too_far' }],
    ['accuracy credit is capped at 100 m', 300, 400, { ok: false, reason: 'too_far' }],
    ['accuracy over 500 m is too vague', 0, 501, { ok: false, reason: 'too_vague' }],
  ])('%s', (_n, metres, accuracy, expected) => {
    expect(checkGeo({ ...north(metres), accuracy }, venue, 150)).toMatchObject(expected);
  });
});

describe('rotating code', () => {
  const secret = 'test-secret';
  const t0 = 1_000 * CODE_WINDOW_MS + 5_000;

  it('shows a 4-digit code and an 8-hex token', () => {
    const c = currentCode(secret, t0);
    expect(c.code).toMatch(/^\d{4}$/);
    expect(c.token).toMatch(/^[0-9a-f]{8}$/);
    expect(c.expiresAt).toBe(1_001 * CODE_WINDOW_MS);
  });

  it.each([
    ['current window', 0, true],
    ['previous window', 1, true],
    ['two windows ago (expired)', 2, false],
  ])('accepts a code from the %s: %s', (_n, windowsAgo, ok) => {
    const { code, token } = currentCode(secret, t0 - windowsAgo * CODE_WINDOW_MS);
    expect(verifyCode(secret, code, t0)).toBe(ok);
    expect(verifyCode(secret, token.toUpperCase(), t0)).toBe(ok);
  });

  it('rejects wrong codes and other weddings\' codes', () => {
    const { code } = currentCode('other-wedding', t0);
    const mine = currentCode(secret, t0).code;
    if (code !== mine) expect(verifyCode(secret, code, t0)).toBe(false);
    expect(verifyCode(secret, 'abcd', t0)).toBe(false);
  });
});
