import { Router } from 'express';
import { z } from 'zod';
import { tx } from '../db/db';
import { type EventRow, all, one, run } from '../db/queries';
import { authenticate, homeFor, loadMemberships, sessionCookie } from '../auth';
import { HttpError, parse } from '../http';
import { isLive } from '../engine/booking';

export const DEMO_OTP = '123456';

const Phone = z.string().trim().regex(/^\+?\d{10,15}$/, 'Enter a valid phone number');
const OtpBody = z.object({ phone: Phone });
const VerifyBody = z.object({ phone: Phone, otp: z.string().trim() });

interface UserRow { id: number; phone: string; name: string | null; lang: string }

export const authRouter = Router();

/** Public: what the login screen and splash show before sign-in (names + the live event's theme). */
authRouter.get('/wedding', (_req, res) => {
  const w = one<{ id: number; name: string; couple_names: string }>(
    `SELECT id, name, couple_names FROM weddings ORDER BY id LIMIT 1`);
  if (!w) throw new HttpError(404, 'not_found', 'No wedding yet');
  const now = Date.now();
  const live = all<EventRow>(`SELECT * FROM events WHERE wedding_id = ? ORDER BY sort_order`, w.id)
    .find((e) => isLive(e, now));
  res.json({ name: w.name, coupleNames: w.couple_names, liveEvent: live ? { type: live.type, name: live.name } : null });
});

authRouter.post('/auth/otp', (req, res) => {
  parse(OtpBody, req.body);
  res.json({ ok: true }); // demo: no SMS, OTP is always 123456
});

authRouter.post('/auth/verify', (req, res) => {
  const { phone, otp } = parse(VerifyBody, req.body);
  if (otp !== DEMO_OTP) throw new HttpError(401, 'bad_otp', 'That code is not right');

  const userId = tx(() => {
    const existing = one<{ id: number }>(`SELECT id FROM users WHERE phone = ?`, phone);
    const id = existing?.id ?? Number(run(`INSERT INTO users (phone) VALUES (?)`, phone).lastInsertRowid);
    // A new phone (guest who scanned the venue QR) joins the wedding as a guest.
    const hasMembership = one(`SELECT 1 AS x FROM memberships WHERE user_id = ?`, id);
    const wedding = one<{ id: number }>(`SELECT id FROM weddings ORDER BY id LIMIT 1`);
    if (!hasMembership && wedding) {
      run(`INSERT INTO memberships (wedding_id, user_id, role) VALUES (?,?,'guest')`, wedding.id, id);
    }
    return id;
  });

  res.cookie(...sessionCookie(userId));
  res.json(meResponse(userId));
});

authRouter.get('/me', authenticate, (req, res) => {
  res.json(meResponse(req.auth!.userId));
});

function meResponse(userId: number) {
  const user = one<UserRow>(`SELECT id, phone, name, lang FROM users WHERE id = ?`, userId)!;
  const memberships = loadMemberships(userId);
  return {
    user,
    memberships: memberships.map((m) => ({ weddingId: m.wedding_id, role: m.role, side: m.side })),
    home: homeFor(memberships),
  };
}
