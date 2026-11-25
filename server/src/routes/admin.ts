// Admin routes (SPEC-LITE §7): events, booths/layout, quotas, family passes, overview, venue code.
import { Router } from 'express';
import { z } from 'zod';
import { tx } from '../db/db';
import {
  type BoothRow, type EventRow, type TicketRow, activeTickets, all, applyPatch, boothsForWedding, getBooth, one,
  refreshVip, run,
} from '../db/queries';
import { requireRole } from '../auth';
import { HttpError, parse } from '../http';
import { ACTIONS } from '../engine/rbac';
import { isEnded, isLive } from '../engine/booking';
import { currentCode } from '../engine/presence';
import { type Pass, type PassEvent, type Side, assertQuota, generateToken, usedByEvent } from '../engine/passes';
import { emitBoothChanged, emitEventStatus } from '../socket';
import { noteEventLive } from '../ticker';
import { boothView } from './views';
import { flagsmithEnabled } from '../sponsors/flags';

const Id = z.coerce.number().int().positive();
const SideSchema = z.enum(['bride', 'groom']);
const QuotasBody = z.object({
  quotas: z.array(z.object({ eventId: z.number().int().positive(), side: SideSchema, max: z.number().int().min(0).max(10000) }))
    .min(1),
});
const PassBody = z.object({
  side: SideSchema,
  label: z.string().trim().min(1).max(120),
  eventIds: z.array(z.number().int().positive()).min(1).max(20).transform((ids) => [...new Set(ids)]),
});

export const adminRouter = Router();

const eventIdsFor = (weddingId: number) =>
  new Set(all<{ id: number }>(`SELECT id FROM events WHERE wedding_id = ?`, weddingId).map((e) => e.id));

function weddingPasses(weddingId: number): { passes: Pass[]; passEvents: PassEvent[] } {
  return {
    passes: all<Pass>(`SELECT id, side, claimed_by_user_id, revoked_at FROM family_passes WHERE wedding_id = ?`, weddingId),
    passEvents: all<PassEvent>(
      `SELECT pe.pass_id, pe.event_id FROM pass_events pe JOIN family_passes p ON p.id = pe.pass_id WHERE p.wedding_id = ?`,
      weddingId),
  };
}

function quotaView(weddingId: number) {
  const { passes, passEvents } = weddingPasses(weddingId);
  const used = { bride: usedByEvent(passes, passEvents, 'bride'), groom: usedByEvent(passes, passEvents, 'groom') };
  const rows = all<{ event_id: number; side: Side; max_passes: number }>(
    `SELECT q.event_id, q.side, q.max_passes FROM pass_quotas q JOIN events e ON e.id = q.event_id WHERE e.wedding_id = ?`,
    weddingId);
  const max = new Map(rows.map((r) => [`${r.event_id}:${r.side}`, r.max_passes]));
  return all<{ id: number; name: string; type: string }>(
    `SELECT id, name, type FROM events WHERE wedding_id = ? ORDER BY sort_order`, weddingId,
  ).map((e) => ({
    eventId: e.id, name: e.name, type: e.type,
    bride: { max: max.get(`${e.id}:bride`) ?? 0, used: used.bride.get(e.id) ?? 0 },
    groom: { max: max.get(`${e.id}:groom`) ?? 0, used: used.groom.get(e.id) ?? 0 },
  }));
}

interface PassRow {
  id: number; side: Side; token: string; label: string;
  claimed_by_user_id: number | null; revoked_at: number | null;
  claimer_name: string | null; claimer_phone: string | null;
}
function passViews(weddingId: number, id?: number) {
  const rows = all<PassRow>(
    `SELECT p.*, u.name AS claimer_name, u.phone AS claimer_phone
     FROM family_passes p LEFT JOIN users u ON u.id = p.claimed_by_user_id
     WHERE p.wedding_id = ? ${id ? 'AND p.id = ?' : ''} ORDER BY p.id DESC`,
    ...(id ? [weddingId, id] : [weddingId]));
  const links = weddingPasses(weddingId).passEvents;
  return rows.map((p) => ({
    id: p.id, side: p.side, label: p.label, url: `/p/${p.token}`,
    eventIds: links.filter((l) => l.pass_id === p.id).map((l) => l.event_id),
    claimedBy: p.claimed_by_user_id ? { userId: p.claimed_by_user_id, name: p.claimer_name, phone: p.claimer_phone } : null,
    revokedAt: p.revoked_at,
  }));
}

// ---- quotas ----
adminRouter.get('/quotas', requireRole(ACTIONS.managePasses), (req, res) => {
  res.json({ quotas: quotaView(req.auth!.weddingId) });
});

adminRouter.put('/quotas', requireRole(ACTIONS.managePasses), (req, res) => {
  const { weddingId } = req.auth!;
  const { quotas } = parse(QuotasBody, req.body);
  tx(() => {
    const mine = eventIdsFor(weddingId);
    for (const q of quotas) {
      if (!mine.has(q.eventId)) throw new HttpError(404, 'not_found', `Event ${q.eventId} not found`);
      run(`INSERT INTO pass_quotas (event_id, side, max_passes) VALUES (?,?,?)
           ON CONFLICT (event_id, side) DO UPDATE SET max_passes = excluded.max_passes`, q.eventId, q.side, q.max);
    }
  });
  res.json({ quotas: quotaView(weddingId) });
});

// ---- family passes ----
adminRouter.get('/passes', requireRole(ACTIONS.managePasses), (req, res) => {
  res.json({ passes: passViews(req.auth!.weddingId) });
});

adminRouter.post('/passes', requireRole(ACTIONS.managePasses), (req, res) => {
  const { weddingId } = req.auth!;
  const body = parse(PassBody, req.body);
  const id = tx(() => {
    const mine = eventIdsFor(weddingId);
    const foreign = body.eventIds.find((e) => !mine.has(e));
    if (foreign) throw new HttpError(404, 'not_found', `Event ${foreign} not found`);

    const { passes, passEvents } = weddingPasses(weddingId);
    const limits = new Map(all<{ event_id: number; max_passes: number }>(
      `SELECT event_id, max_passes FROM pass_quotas WHERE side = ? AND event_id IN (${body.eventIds.map(() => '?').join(',')})`,
      body.side, ...body.eventIds).map((r) => [r.event_id, r.max_passes]));
    assertQuota(body.eventIds, usedByEvent(passes, passEvents, body.side), limits);

    const passId = Number(run(`INSERT INTO family_passes (wedding_id, side, token, label) VALUES (?,?,?,?)`,
      weddingId, body.side, generateToken(), body.label).lastInsertRowid);
    for (const e of body.eventIds) run(`INSERT INTO pass_events (pass_id, event_id) VALUES (?,?)`, passId, e);
    return passId;
  });
  res.status(201).json({ pass: passViews(weddingId, id)[0] });
});

adminRouter.post('/passes/:id/revoke', requireRole(ACTIONS.managePasses), (req, res) => {
  const { weddingId } = req.auth!;
  const id = parse(Id, req.params.id);
  const now = Date.now();
  const changed = tx(() => {
    const p = one<{ claimed_by_user_id: number | null }>(
      `SELECT claimed_by_user_id FROM family_passes WHERE id = ? AND wedding_id = ?`, id, weddingId);
    if (!p) throw new HttpError(404, 'not_found', 'Pass not found');
    run(`UPDATE family_passes SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, now, id);
    return p.claimed_by_user_id ? refreshVip(p.claimed_by_user_id, weddingId) : new Map<number, number[]>();
  });
  res.json({ pass: passViews(weddingId, id)[0] });
  for (const [boothId, ids] of changed) emitBoothChanged(boothId, now, ids);
});

// ---- events ----
const EventType = z.enum(['mehendi', 'sangeet', 'muhurtham', 'feast']);
const EventFields = z.object({
  type: EventType,
  name: z.string().trim().min(1).max(80),
  startsAt: z.number().int().nonnegative(),
  endsAt: z.number().int().nonnegative(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});
const timesOk = (e: { startsAt?: number; endsAt?: number }) =>
  e.startsAt === undefined || e.endsAt === undefined || e.endsAt > e.startsAt;
const EventCreate = EventFields.refine(timesOk, { message: 'endsAt must be after startsAt', path: ['endsAt'] });
const EventPatch = EventFields.partial().refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });
const LiveBody = z.object({ override: z.enum(['auto', 'live', 'ended']) });

function eventView(e: EventRow, now: number) {
  return {
    id: e.id, type: e.type, name: e.name, startsAt: e.starts_at, endsAt: e.ends_at,
    sortOrder: e.sort_order, override: e.status_override, live: isLive(e, now), ended: isEnded(e, now),
  };
}
function myEvent(weddingId: number, id: number): EventRow {
  const e = one<EventRow>(`SELECT * FROM events WHERE id = ? AND wedding_id = ?`, id, weddingId);
  if (!e) throw new HttpError(404, 'not_found', 'Event not found');
  return e;
}

adminRouter.get('/events', requireRole(ACTIONS.manageEvents), (req, res) => {
  const now = Date.now();
  res.json({
    events: all<EventRow>(`SELECT * FROM events WHERE wedding_id = ? ORDER BY sort_order, id`, req.auth!.weddingId)
      .map((e) => eventView(e, now)),
  });
});

adminRouter.post('/events', requireRole(ACTIONS.manageEvents), (req, res) => {
  const { weddingId } = req.auth!;
  const b = parse(EventCreate, req.body);
  const now = Date.now();
  const id = tx(() => {
    const order = b.sortOrder
      ?? one<{ n: number }>(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM events WHERE wedding_id = ?`, weddingId)!.n;
    return Number(run(
      `INSERT INTO events (wedding_id, type, name, starts_at, ends_at, sort_order) VALUES (?,?,?,?,?,?)`,
      weddingId, b.type, b.name, b.startsAt, b.endsAt, order).lastInsertRowid);
  });
  const e = myEvent(weddingId, id);
  res.status(201).json({ event: eventView(e, now) });
  afterEventChange(e, false, now);
});

adminRouter.patch('/events/:id', requireRole(ACTIONS.manageEvents), (req, res) => {
  const { weddingId } = req.auth!;
  const id = parse(Id, req.params.id);
  const b = parse(EventPatch, req.body);
  const now = Date.now();
  const { before, after, cancelled } = tx(() => {
    const before = myEvent(weddingId, id);
    const startsAt = b.startsAt ?? before.starts_at;
    const endsAt = b.endsAt ?? before.ends_at;
    if (endsAt <= startsAt) throw new HttpError(400, 'bad_request', 'endsAt: endsAt must be after startsAt');
    run(`UPDATE events SET type = ?, name = ?, starts_at = ?, ends_at = ?, sort_order = ? WHERE id = ?`,
      b.type ?? before.type, b.name ?? before.name, startsAt, endsAt, b.sortOrder ?? before.sort_order, id);
    const after = myEvent(weddingId, id);
    return { before, after, cancelled: cancelIfEnded(after, now) };
  });
  res.json({ event: eventView(after, now) });
  afterEventChange(after, isLive(before, now), now, cancelled);
});

adminRouter.post('/events/:id/live', requireRole(ACTIONS.manageEvents), (req, res) => {
  const { weddingId } = req.auth!;
  const id = parse(Id, req.params.id);
  const { override } = parse(LiveBody, req.body);
  const now = Date.now();
  const { before, after, cancelled } = tx(() => {
    const before = myEvent(weddingId, id);
    run(`UPDATE events SET status_override = ? WHERE id = ?`, override, id);
    const after = myEvent(weddingId, id);
    return { before, after, cancelled: cancelIfEnded(after, now) };
  });
  res.json({ event: eventView(after, now) });
  afterEventChange(after, isLive(before, now), now, cancelled);
});

/** An ended event's open tickets are cancelled now (the ticker would do it within 10 s). Call inside tx(). */
function cancelIfEnded(e: EventRow, now: number): Map<number, number[]> {
  const byBooth = new Map<number, number[]>();
  if (!isEnded(e, now)) return byBooth;
  const open = all<TicketRow>(
    `SELECT * FROM tickets WHERE event_id = ? AND status IN ('waiting','away','called','serving')`, e.id);
  for (const t of open) {
    applyPatch(t.id, { status: 'cancelled' });
    byBooth.set(t.booth_id, [...(byBooth.get(t.booth_id) ?? []), t.id]);
  }
  return byBooth;
}

/** After commit: tell the wedding when live flips, and refresh booths whose tickets were cancelled. */
function afterEventChange(e: EventRow, wasLive: boolean, now: number, cancelled = new Map<number, number[]>()): void {
  const live = isLive(e, now);
  noteEventLive(e.id, live);
  if (live !== wasLive) emitEventStatus(e.wedding_id, e, live);
  for (const [boothId, ids] of cancelled) emitBoothChanged(boothId, now, ids);
}

// ---- booths / layout ----
const Pct = z.number().min(0).max(100);
const Phone = z.string().trim().regex(/^\+?\d{10,15}$/, 'Enter a valid phone number');
const Options = z.array(z.object({
  label: z.string().trim().min(1).max(80),
  minutes: z.number().positive().max(240),
})).min(1).max(10)
  .refine((o) => new Set(o.map((x) => x.label)).size === o.length, { message: 'Option labels must be unique' });
const BoothFields = z.object({
  name: z.string().trim().min(1).max(80),
  serviceType: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{1,30}$/, 'Use a short lowercase word'),
  options: Options,
  artists: z.number().int().min(1).max(20),
  roundSeats: z.number().int().min(1).max(1000).nullable(),
  roundMinutes: z.number().int().min(1).max(240).nullable(),
  paused: z.boolean(),
});
const BoothCreate = BoothFields.extend({
  eventId: z.number().int().positive(),
  mode: z.enum(['live', 'batch']),
  codePrefix: z.string().trim().toUpperCase().regex(/^[A-Z]{1,3}$/, '1–3 letters').optional(),
  x: Pct.default(50),
  y: Pct.default(50),
  artists: BoothFields.shape.artists.default(1),
  roundSeats: BoothFields.shape.roundSeats.default(null),
  roundMinutes: BoothFields.shape.roundMinutes.default(null),
  paused: BoothFields.shape.paused.default(false),
});
const BoothPatch = BoothFields.partial().refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });
const PinBody = z.object({ x_pct: Pct, y_pct: Pct });
const HandlerBody = z.object({ phone: Phone });

function handlersByBooth(weddingId: number): Map<number, { userId: number; name: string | null; phone: string }[]> {
  const rows = all<{ booth_id: number; id: number; name: string | null; phone: string }>(
    `SELECT h.booth_id, u.id, u.name, u.phone FROM booth_handlers h
     JOIN users u ON u.id = h.user_id JOIN booths b ON b.id = h.booth_id JOIN events e ON e.id = b.event_id
     WHERE e.wedding_id = ? ORDER BY u.id`, weddingId);
  const out = new Map<number, { userId: number; name: string | null; phone: string }[]>();
  for (const r of rows) out.set(r.booth_id, [...(out.get(r.booth_id) ?? []), { userId: r.id, name: r.name, phone: r.phone }]);
  return out;
}
function adminBoothView(b: BoothRow, now: number, handlers = handlersByBooth(b.wedding_id)) {
  return { ...boothView(b, now), codePrefix: b.code_prefix, speedFactor: b.speed_factor, handlers: handlers.get(b.id) ?? [] };
}
function myBooth(weddingId: number, id: number): BoothRow {
  const b = getBooth(id);
  if (!b || b.wedding_id !== weddingId) throw new HttpError(404, 'not_found', 'Booth not found');
  return b;
}
function assertBatchFields(mode: 'live' | 'batch', seats: number | null, minutes: number | null): void {
  if (mode === 'batch' && (seats === null || minutes === null)) {
    throw new HttpError(400, 'bad_request', 'A feast (batch) booth needs roundSeats and roundMinutes');
  }
}
/** Ticket codes read `M-014`; prefixes stay unique per wedding so codes never clash. Call inside tx(). */
function pickPrefix(weddingId: number, name: string, wanted?: string): string {
  const taken = new Set(boothsForWedding(weddingId).map((b) => b.code_prefix));
  if (wanted) {
    if (taken.has(wanted)) throw new HttpError(409, 'prefix_taken', `Code prefix ${wanted} is already used`);
    return wanted;
  }
  const words = name.toUpperCase().replace(/[^A-Z ]/g, '').split(/\s+/).filter(Boolean);
  const initials = words.map((w) => w[0]).join('').slice(0, 3);
  // first letter, then initials ("Mehendi table" → M, MT), then any letter of the name
  for (const c of [words.join('')[0], initials, ...words.join('')]) if (c && !taken.has(c)) return c;
  for (const a of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (!taken.has(a + c)) return a + c;
  }
  throw new HttpError(409, 'prefix_taken', 'No free code prefix, pass codePrefix');
}

adminRouter.get('/booths', requireRole(ACTIONS.manageLayout), (req, res) => {
  const { weddingId } = req.auth!;
  const now = Date.now();
  const handlers = handlersByBooth(weddingId);
  res.json({ booths: boothsForWedding(weddingId).map((b) => adminBoothView(b, now, handlers)) });
});

adminRouter.post('/booths', requireRole(ACTIONS.manageLayout), (req, res) => {
  const { weddingId } = req.auth!;
  const b = parse(BoothCreate, req.body);
  assertBatchFields(b.mode, b.roundSeats, b.roundMinutes);
  const now = Date.now();
  const id = tx(() => {
    myEvent(weddingId, b.eventId);
    const prefix = pickPrefix(weddingId, b.name, b.codePrefix);
    return Number(run(
      `INSERT INTO booths (event_id, name, service_type, code_prefix, mode, x_pct, y_pct, options_json,
                           artists, round_seats, round_minutes, paused) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      b.eventId, b.name, b.serviceType, prefix, b.mode, b.x, b.y, JSON.stringify(b.options),
      b.artists, b.roundSeats, b.roundMinutes, b.paused ? 1 : 0).lastInsertRowid);
  });
  res.status(201).json({ booth: adminBoothView(myBooth(weddingId, id), now) });
  emitBoothChanged(id, now);
});

adminRouter.patch('/booths/:id', requireRole(ACTIONS.manageLayout), (req, res) => {
  const { weddingId } = req.auth!;
  const id = parse(Id, req.params.id);
  const b = parse(BoothPatch, req.body);
  const now = Date.now();
  tx(() => {
    const cur = myBooth(weddingId, id);
    const seats = b.roundSeats !== undefined ? b.roundSeats : cur.round_seats;
    const minutes = b.roundMinutes !== undefined ? b.roundMinutes : cur.round_minutes;
    assertBatchFields(cur.mode, seats, minutes);
    run(`UPDATE booths SET name = ?, service_type = ?, options_json = ?, artists = ?, round_seats = ?,
                           round_minutes = ?, paused = ? WHERE id = ?`,
      b.name ?? cur.name, b.serviceType ?? cur.service_type,
      b.options ? JSON.stringify(b.options) : cur.options_json, b.artists ?? cur.artists, seats, minutes,
      b.paused === undefined ? cur.paused : b.paused ? 1 : 0, id);
  });
  res.json({ booth: adminBoothView(myBooth(weddingId, id), now) });
  emitBoothChanged(id, now);
});

adminRouter.patch('/booths/:id/pin', requireRole(ACTIONS.manageLayout), (req, res) => {
  const { weddingId } = req.auth!;
  const id = parse(Id, req.params.id);
  const { x_pct, y_pct } = parse(PinBody, req.body);
  const now = Date.now();
  tx(() => {
    myBooth(weddingId, id);
    run(`UPDATE booths SET x_pct = ?, y_pct = ? WHERE id = ?`, x_pct, y_pct, id);
  });
  res.json({ booth: adminBoothView(myBooth(weddingId, id), now) });
  emitBoothChanged(id, now);
});

/** Assign a handler by phone. Unknown phones get a user + booth_handler membership, ready for OTP login. */
adminRouter.post('/booths/:id/handlers', requireRole(ACTIONS.manageLayout), (req, res) => {
  const { weddingId } = req.auth!;
  const id = parse(Id, req.params.id);
  const { phone } = parse(HandlerBody, req.body);
  const now = Date.now();
  tx(() => {
    myBooth(weddingId, id);
    const userId = one<{ id: number }>(`SELECT id FROM users WHERE phone = ?`, phone)?.id
      ?? Number(run(`INSERT INTO users (phone) VALUES (?)`, phone).lastInsertRowid);
    run(`INSERT OR IGNORE INTO memberships (wedding_id, user_id, role) VALUES (?,?,'booth_handler')`, weddingId, userId);
    run(`INSERT OR IGNORE INTO booth_handlers (booth_id, user_id) VALUES (?,?)`, id, userId);
  });
  res.status(201).json({ booth: adminBoothView(myBooth(weddingId, id), now) });
});

// ---- overview + venue screen ----
const count = (sql: string, ...p: number[]) => one<{ n: number }>(sql, ...p)!.n;

adminRouter.get('/overview', requireRole(ACTIONS.viewOverview), (req, res) => {
  const { weddingId } = req.auth!;
  const now = Date.now();
  const events = all<EventRow>(`SELECT * FROM events WHERE wedding_id = ? ORDER BY sort_order, id`, weddingId);
  const liveIds = new Set(events.filter((e) => isLive(e, now)).map((e) => e.id));
  const booths = boothsForWedding(weddingId).filter((b) => liveIds.has(b.event_id)).map((b) => boothView(b, now));
  const open = booths.filter((b) => !b.paused);
  const longest = booths.reduce<(typeof booths)[number] | null>((m, b) => (!m || b.waitMin > m.waitMin ? b : m), null);

  res.json({
    kpis: {
      checkedIn: count(`SELECT COUNT(*) AS n FROM presence WHERE wedding_id = ? AND valid_until > ?`, weddingId, now),
      activeTickets: count(
        `SELECT COUNT(*) AS n FROM tickets t JOIN events e ON e.id = t.event_id
         WHERE e.wedding_id = ? AND t.status IN ('waiting','away','called','serving')`, weddingId),
      // Current join-now wait, averaged over open booths of live events.
      avgWaitMin: open.length ? Math.round(open.reduce((s, b) => s + b.waitMin, 0) / open.length) : 0,
      longestQueue: longest && { boothId: longest.id, name: longest.name, waiting: longest.waiting, waitMin: longest.waitMin },
      passes: {
        issued: count(`SELECT COUNT(*) AS n FROM family_passes WHERE wedding_id = ? AND revoked_at IS NULL`, weddingId),
        used: count(`SELECT COUNT(*) AS n FROM family_passes
                     WHERE wedding_id = ? AND revoked_at IS NULL AND claimed_by_user_id IS NOT NULL`, weddingId),
      },
    },
    events: events.map((e) => eventView(e, now)),
    booths, // live map badges
    abTest: flagsmithEnabled() ? etaAbTest(weddingId) : null,
  });
});

/** Flagsmith eta_style A/B (§14.2): joins and guest cancels per variant. */
function etaAbTest(weddingId: number) {
  const rows = all<{ variant: 'minutes' | 'people'; joined: number; cancelled: number }>(
    `SELECT a.variant, COUNT(*) AS joined, SUM(a.cancelled) AS cancelled
     FROM ab_eta a JOIN tickets t ON t.id = a.ticket_id JOIN events e ON e.id = t.event_id
     WHERE e.wedding_id = ? GROUP BY a.variant`, weddingId);
  const arm = (v: 'minutes' | 'people') => {
    const r = rows.find((x) => x.variant === v);
    const joined = r?.joined ?? 0;
    const cancelled = r?.cancelled ?? 0;
    return { joined, cancelled, cancelRate: joined ? Math.round((cancelled / joined) * 100) : null };
  };
  return { minutes: arm('minutes'), people: arm('people') };
}

/** Venue screen: the rotating code (typed by hand), the QR token, and who's being served per live booth. */
adminRouter.get('/venue-code', requireRole(ACTIONS.viewOverview), (req, res) => {
  const { weddingId } = req.auth!;
  const now = Date.now();
  const w = one<{ qr_secret: string }>(`SELECT qr_secret FROM weddings WHERE id = ?`, weddingId)!;
  const { code, token, expiresAt } = currentCode(w.qr_secret, now);
  const liveIds = new Set(all<EventRow>(`SELECT * FROM events WHERE wedding_id = ?`, weddingId)
    .filter((e) => isLive(e, now)).map((e) => e.id));
  const nowServing = boothsForWedding(weddingId).filter((b) => liveIds.has(b.event_id)).map((b) => ({
    boothId: b.id, name: b.name,
    codes: activeTickets(b.id).filter((t) => t.status === 'called' || t.status === 'serving').map((t) => t.code),
  }));
  res.json({ code, token, expiresAt, nowServing });
});
