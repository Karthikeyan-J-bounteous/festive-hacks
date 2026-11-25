// Presence (SPEC-LITE §6 "Presence"): geofence OR rotating venue code. Pure (crypto is computation, not I/O).
import { createHmac } from 'node:crypto';

export const CODE_WINDOW_MS = 30_000;
export const PRESENCE_TTL_MS = 12 * 60 * 60_000;
export const MAX_ACCURACY_M = 500;

export interface LatLng { lat: number; lng: number }

export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export type GeoResult = { ok: true; distance: number } | { ok: false; reason: 'too_vague' | 'too_far'; distance: number };

/** Pass if distance minus (accuracy, capped at 100 m) is within the radius. Accuracy > 500 m is rejected. */
export function checkGeo(user: LatLng & { accuracy: number }, venue: LatLng, radiusM: number): GeoResult {
  const distance = haversineMeters(user, venue);
  if (!(user.accuracy >= 0) || user.accuracy > MAX_ACCURACY_M) return { ok: false, reason: 'too_vague', distance };
  return distance - Math.min(user.accuracy, 100) <= radiusM
    ? { ok: true, distance }
    : { ok: false, reason: 'too_far', distance };
}

function codeForWindow(secret: string, window: number): { token: string; code: string } {
  const h = createHmac('sha256', secret).update(String(window)).digest('hex');
  const token = h.slice(0, 8);
  return { token, code: String(parseInt(token, 16) % 10_000).padStart(4, '0') };
}

/** What the venue screen shows right now. `token` goes in the QR, `code` is typed by hand. */
export function currentCode(secret: string, now: number) {
  const window = Math.floor(now / CODE_WINDOW_MS);
  return { ...codeForWindow(secret, window), window, expiresAt: (window + 1) * CODE_WINDOW_MS };
}

/** Accepts the 4-digit code or the 8-hex QR token, for the current or previous window only. */
export function verifyCode(secret: string, input: string, now: number): boolean {
  const value = input.trim().toLowerCase();
  const window = Math.floor(now / CODE_WINDOW_MS);
  for (const w of [window, window - 1]) {
    const c = codeForWindow(secret, w);
    if (value === c.code || value === c.token) return true;
  }
  return false;
}
