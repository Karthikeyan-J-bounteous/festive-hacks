import { Router } from 'express';
import { z } from 'zod';
import { tx } from '../db/db';
import {
  BoothRow, EventRow, TicketRow, activeTickets, all, boothOptions, boothsForWedding, getBooth, getEvent,
  getTicket, hasPresence, one, passesForUser, run, applyPatch,
} from '../db/queries';
import { requireRole } from '../auth';
import { HttpError, parse } from '../http';
import { ACTIONS } from '../engine/rbac';
import { JOIN_ERROR_STATUS, JoinError, checkJoin, isLive } from '../engine/booking';
import { PRESENCE_TTL_MS, checkGeo, verifyCode } from '../engine/presence';
import { formatCode, transition } from '../engine/live';
import { checkClaim, isFamilyFor } from '../engine/passes';
import { boothView, ticketView } from './views';
import { emitBoothChanged } from '../socket';

const JOIN_MESSAGES: Record<JoinError, string> = {
  event_not_live: 'This event has not started yet',
  booth_paused: 'This booth is paused for a moment',
  presence_required: 'Verify you are at the venue first',
  duplicate: 'You are already in this queue',
  max_tickets: 'You can hold at most 3 queues per event',
  bad_party_size: 'Party size is not allowed for this booth',
  bad_option: 'Pick one of the listed options',
};

const Id = z.coerce.number().int().positive();
const PresenceBody = z.union([
  z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy: z.number().nonnegative() }),
  z.object({ code: z.string().trim().min(4).max(16) }),
]);
const JoinBody = z.object({
  boothId: z.number().int().positive(),
  option: z.string().trim().min(1).max(80),
  partySize: z.number().int().default(1),
});
const ClaimBody = z.object({ token: z.string().trim().min(8).max(64) });

export const guestRouter = Router();
guestRouter.use(requireRole(ACTIONS.joinQueue));

function myTicketViews(userId: number, weddingId: number, now: number) {
  const mine = all<TicketRow>(
    `SELECT t.* FROM tickets t JOIN events e ON e.id = t.event_id
     WHERE t.user_id = ? AND e.wedding_id = ? AND t.status IN ('waiting','away','called','serving') ORDER BY t.joined_at`,
    userId, weddingId);
  return mine.map((t) => {
    const booth = getBooth(t.booth_id)!;
    return ticketView(t, booth, activeTickets(booth.id), now);
  });
}

function myPass(userId: number, weddingId: number) {
  const p = one<{ id: number; side: string; label: string }>(
    `SELECT id, side, label FROM family_passes WHERE wedding_id = ? AND claimed_by_user_id = ? AND revoked_at IS NULL`,
    weddingId, userId);
  if (!p) return null;
  const eventIds = all<{ event_id: number }>(`SELECT event_id FROM pass_events WHERE pass_id = ?`, p.id).map((r) => r.event_id);
  return { id: p.id, side: p.side, label: p.label, eventIds };
}

guestRouter.get('/bootstrap', (req, res) => {
  const { userId, weddingId } = req.auth!;
  const now = Date.now();
  const wedding = one(`SELECT id, name, couple_names FROM weddings WHERE id = ?`, weddingId);
  const events = all<EventRow>(`SELECT * FROM events WHERE wedding_id = ? ORDER BY sort_order`, weddingId)
    .filter((e) => isLive(e, now));
  const liveIds = new Set(events.map((e) => e.id));
  const presence = one<{ valid_until: number }>(
    `SELECT valid_until FROM presence WHERE user_id = ? AND wedding_id = ?`, userId, weddingId);

  res.json({
    wedding,
    // `theme` is the event type; the web theme.service maps it to CSS variables.
    events: events.map((e) => ({ id: e.id, type: e.type, theme: e.type, name: e.name, startsAt: e.starts_at, endsAt: e.ends_at })),
    booths: boothsForWedding(weddingId).filter((b) => liveIds.has(b.event_id)).map((b) => boothView(b, now)),
    tickets: myTicketViews(userId, weddingId, now),
    pass: myPass(userId, weddingId),
    presence: { valid: !!presence && presence.valid_until > now, validUntil: presence?.valid_until ?? null },
  });
});

guestRouter.post('/presence', (req, res) => {
  const { userId, weddingId } = req.auth!;
  const body = parse(PresenceBody, req.body);
  const now = Date.now();
  const w = one<{ venue_lat: number; venue_lng: number; radius_m: number; qr_secret: string }>(
    `SELECT venue_lat, venue_lng, radius_m, qr_secret FROM weddings WHERE id = ?`, weddingId)!;

  if ('code' in body) {
    if (!verifyCode(w.qr_secret, body.code, now)) throw new HttpError(403, 'bad_code', 'That code has expired, try the one on screen now');
  } else {
    const geo = checkGeo(body, { lat: w.venue_lat, lng: w.venue_lng }, w.radius_m);
    if (!geo.ok) {
      throw new HttpError(403, geo.reason, geo.reason === 'too_vague'
        ? 'Location is too imprecise, use the venue code instead'
        : 'You seem to be away from the venue, use the venue code instead');
    }
  }

  const validUntil = now + PRESENCE_TTL_MS;
  tx(() => run(
    `INSERT INTO presence (user_id, wedding_id, valid_until) VALUES (?,?,?)
     ON CONFLICT (user_id, wedding_id) DO UPDATE SET valid_until = excluded.valid_until`,
    userId, weddingId, validUntil));
  res.json({ valid: true, validUntil, method: 'code' in body ? 'code' : 'geo' });
});

guestRouter.post('/tickets', (req, res) => {
  const { userId, weddingId } = req.auth!;
  const body = parse(JoinBody, req.body);
  const now = Date.now();

  const ticketId = tx(() => {
    const booth = getBooth(body.boothId);
    if (!booth || booth.wedding_id !== weddingId) throw new HttpError(404, 'not_found', 'Booth not found');
    const event = getEvent(booth.event_id)!;
    const option = boothOptions(booth).find((o) => o.label === body.option);
    const count = (sql: string, ...p: number[]) => one<{ n: number }>(sql, ...p)!.n;

    const err = checkJoin({
      eventLive: isLive(event, now),
      boothPaused: !!booth.paused,
      presenceValid: hasPresence(userId, weddingId, now),
      hasActiveAtBooth: count(
        `SELECT COUNT(*) AS n FROM tickets WHERE user_id = ? AND booth_id = ? AND status IN ('waiting','away','called','serving')`,
        userId, booth.id) > 0,
      activeInEvent: count(
        `SELECT COUNT(*) AS n FROM tickets WHERE user_id = ? AND event_id = ? AND status IN ('waiting','away','called','serving')`,
        userId, event.id),
      serviceType: booth.service_type,
      partySize: body.partySize,
      optionValid: !!option,
    });
    if (err) throw new HttpError(JOIN_ERROR_STATUS[err], err, JOIN_MESSAGES[err]);

    const { passes, passEvents } = passesForUser(userId, weddingId);
    const seq = one<{ s: number }>(`SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM tickets WHERE booth_id = ?`, booth.id)!.s;
    const n = count(`SELECT COUNT(*) AS n FROM tickets WHERE booth_id = ?`, booth.id) + 1;
    return Number(run(
      `INSERT INTO tickets (booth_id, event_id, user_id, code, option_label, base_minutes, party_size, is_vip, status, seq, joined_at)
       VALUES (?,?,?,?,?,?,?,?,'waiting',?,?)`,
      booth.id, event.id, userId, formatCode(booth.code_prefix, n), option!.label, option!.minutes, body.partySize,
      isFamilyFor(userId, event.id, passes, passEvents) ? 1 : 0, Math.ceil(seq), now,
    ).lastInsertRowid);
  });

  res.status(201).json(view(ticketId, now));
  emitBoothChanged(body.boothId, now);
});

guestRouter.post('/tickets/:id/:action(cancel|away|back)', (req, res) => {
  const { userId } = req.auth!;
  const id = parse(Id, req.params.id);
  const action = req.params.action as 'cancel' | 'away' | 'back';
  const now = Date.now();
  const boothId = tx(() => {
    const t = getTicket(id);
    if (!t || t.user_id !== userId) throw new HttpError(404, 'not_found', 'Ticket not found');
    applyPatch(t.id, transition(t, action, now));
    return t.booth_id;
  });
  res.json(view(id, now));
  emitBoothChanged(boothId, now, [id]);
});

guestRouter.post('/passes/claim', (req, res) => {
  const { userId, weddingId } = req.auth!;
  const { token } = parse(ClaimBody, req.body);
  tx(() => {
    const pass = one<{ id: number; side: 'bride' | 'groom'; claimed_by_user_id: number | null; revoked_at: number | null }>(
      `SELECT id, side, claimed_by_user_id, revoked_at FROM family_passes WHERE token = ? AND wedding_id = ?`, token, weddingId);
    const other = !!one(
      `SELECT 1 AS x FROM family_passes WHERE wedding_id = ? AND claimed_by_user_id = ? AND revoked_at IS NULL AND id != ?`,
      weddingId, userId, pass?.id ?? -1);
    if (checkClaim(pass, userId, other) === 'claim') {
      const r = run(`UPDATE family_passes SET claimed_by_user_id = ? WHERE id = ? AND claimed_by_user_id IS NULL`, userId, pass!.id);
      if (Number(r.changes) === 0) throw new HttpError(409, 'already_claimed', 'This pass was already claimed');
    }
  });
  res.json({ pass: myPass(userId, weddingId) });
});

function view(ticketId: number, now: number) {
  const t = getTicket(ticketId)!;
  const booth: BoothRow = getBooth(t.booth_id)!;
  return { ticket: ticketView(t, booth, activeTickets(booth.id), now) };
}
