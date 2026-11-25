// Session cookie + role checks (SPEC-LITE §2). The JWT carries only the user id;
// roles are always loaded from memberships.
import type { CookieOptions, Request, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './env';
import { all } from './db/queries';
import { HttpError } from './http';
import { Role, authorize } from './engine/rbac';

export const SESSION_COOKIE = 'varisai_session';
const SESSION_DAYS = 7;

export interface Membership {
  id: number;
  wedding_id: number;
  role: Role;
  side: 'bride' | 'groom' | null;
}
export interface Auth {
  userId: number;
  weddingId: number;
  memberships: Membership[];
  handlerBoothIds: number[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { auth?: Auth }
  }
}

export function sessionCookie(userId: number): [string, string, CookieOptions] {
  const token = jwt.sign({ uid: userId }, config.jwtSecret, { expiresIn: `${SESSION_DAYS}d` });
  return [SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 24 * 60 * 60_000,
  }];
}

export function loadMemberships(userId: number): Membership[] {
  return all<Membership>(
    `SELECT id, wedding_id, role, side FROM memberships WHERE user_id = ? ORDER BY wedding_id, id`, userId);
}

/** Home screen per §2: admin wins over handler wins over guest. */
export function homeFor(memberships: readonly Membership[]): string {
  if (memberships.some((m) => m.role === 'admin')) return '/admin';
  if (memberships.some((m) => m.role === 'booth_handler')) return '/booth';
  return '/w';
}

/** Verify the session cookie and load roles. Throws 401 without a valid session. */
export function loadAuth(req: Request): Auth {
  if (req.auth) return req.auth;
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) throw new HttpError(401, 'unauthenticated', 'Please log in');
  let uid: number;
  try {
    uid = Number((jwt.verify(token, config.jwtSecret) as { uid: unknown }).uid);
  } catch {
    throw new HttpError(401, 'unauthenticated', 'Session expired, please log in again');
  }
  if (!Number.isInteger(uid)) throw new HttpError(401, 'unauthenticated', 'Please log in');

  const memberships = loadMemberships(uid);
  if (memberships.length === 0) throw new HttpError(403, 'no_membership', 'You are not part of this wedding');
  // One wedding per session: the user's first wedding.
  const weddingId = memberships[0].wedding_id;
  const handlerBoothIds = all<{ booth_id: number }>(
    `SELECT h.booth_id FROM booth_handlers h JOIN booths b ON b.id = h.booth_id JOIN events e ON e.id = b.event_id
     WHERE h.user_id = ? AND e.wedding_id = ?`, uid, weddingId).map((r) => r.booth_id);

  req.auth = { userId: uid, weddingId, memberships: memberships.filter((m) => m.wedding_id === weddingId), handlerBoothIds };
  return req.auth;
}

export const authenticate: RequestHandler = (req, _res, next) => {
  loadAuth(req);
  next();
};

/**
 * Allow the request only if a membership has one of `roles`. With `boothId`, a booth handler
 * must also be assigned to that booth (admins pass). `boothId` resolves the booth from the
 * request and should throw a 404 if it doesn't exist in the user's wedding.
 */
export function requireRole(
  roles: readonly Role[],
  opts: { boothId?: (req: Request, auth: Auth) => number } = {},
): RequestHandler {
  return (req, _res, next) => {
    const auth = loadAuth(req);
    const boothId = opts.boothId?.(req, auth);
    if (!authorize(auth.memberships, roles, { boothId, handlerBoothIds: auth.handlerBoothIds })) {
      throw new HttpError(403, 'forbidden', boothId !== undefined ? 'You are not assigned to this booth' : 'Not allowed');
    }
    next();
  };
}
