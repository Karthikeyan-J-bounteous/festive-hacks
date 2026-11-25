import { Request, Router } from 'express';
import { z } from 'zod';
import { tx } from '../db/db';
import {
  activeTickets, all, applyPatch, boothRounds, boothsForHandler, boothsForWedding, busyUsersElsewhere, getBooth,
  getTicket, run, BoothRow,
} from '../db/queries';
import { Auth, requireRole } from '../auth';
import { HttpError, parse } from '../http';
import { ACTIONS } from '../engine/rbac';
import { callNext, learnSpeed, skip, transition } from '../engine/live';
import { startNextRound } from '../engine/batch';
import { isInProgress } from '../engine/types';
import { boothState, ticketView } from './views';
import { emitBoothChanged, emitCalled } from '../socket';

const Id = z.coerce.number().int().positive();
const PauseBody = z.object({ paused: z.boolean().optional() }).default({});

/** Booth from `:id`, 404 unless it belongs to the caller's wedding. */
function boothFromParam(req: Request, auth: Auth): number {
  const booth = getBooth(parse(Id, req.params.id));
  if (!booth || booth.wedding_id !== auth.weddingId) throw new HttpError(404, 'not_found', 'Booth not found');
  return booth.id;
}
/** Booth of the ticket in `:id`, 404 unless it belongs to the caller's wedding. */
function boothFromTicket(req: Request, auth: Auth): number {
  const t = getTicket(parse(Id, req.params.id));
  const booth = t && getBooth(t.booth_id);
  if (!booth || booth.wedding_id !== auth.weddingId) throw new HttpError(404, 'not_found', 'Ticket not found');
  return booth.id;
}

const operateBooth = requireRole(ACTIONS.operateBooth, { boothId: boothFromParam });
const operateTicket = requireRole(ACTIONS.operateBooth, { boothId: boothFromTicket });

function guestNames(boothIds: number[]): Map<number, string | null> {
  if (boothIds.length === 0) return new Map();
  const rows = all<{ id: number; name: string | null }>(
    `SELECT DISTINCT u.id, u.name FROM users u JOIN tickets t ON t.user_id = u.id
     WHERE t.booth_id IN (${boothIds.map(() => '?').join(',')}) AND t.status IN ('waiting','away','called','serving')`,
    ...boothIds);
  return new Map(rows.map((r) => [r.id, r.name]));
}

function stateOf(booth: BoothRow, now: number) {
  return boothState(booth, now, guestNames([booth.id]));
}

export const boothRouter = Router();

boothRouter.get('/booths', requireRole(ACTIONS.operateBooth), (req, res) => {
  const { userId, weddingId, memberships } = req.auth!;
  const now = Date.now();
  const booths = memberships.some((m) => m.role === 'admin')
    ? boothsForWedding(weddingId)
    : boothsForHandler(userId, weddingId);
  const names = guestNames(booths.map((b) => b.id));
  res.json({ booths: booths.map((b) => boothState(b, now, names)) });
});

boothRouter.post('/booths/:id/call-next', operateBooth, (req, res) => {
  const id = parse(Id, req.params.id);
  const now = Date.now();
  const result = tx(() => {
    const booth = getBooth(id)!;
    if (booth.mode !== 'live') throw new HttpError(409, 'not_live_booth', 'Feast booths seat by rounds');
    const tickets = activeTickets(id);
    const called = callNext(booth, tickets, busyUsersElsewhere(id), now);
    if (!called) {
      if (booth.paused) throw new HttpError(409, 'booth_paused', 'Resume the booth first');
      if (tickets.filter((t) => isInProgress(t.status)).length >= booth.artists) {
        throw new HttpError(409, 'artists_busy', 'Every artist is busy, finish a guest first');
      }
      throw new HttpError(409, 'queue_empty', 'Nobody is waiting');
    }
    applyPatch(called.ticketId, called.patch);
    run(`UPDATE booths SET regulars_since_vip = ? WHERE id = ?`, called.regularsSinceVip, id);
    return called;
  });
  const booth = getBooth(id)!;
  const t = getTicket(result.ticketId)!;
  res.json({
    ticket: ticketView(t, booth, activeTickets(id), now),
    deferredOthers: result.deferredOthers,
    booth: stateOf(booth, now),
  });
  emitCalled(result.ticketId, now);
  emitBoothChanged(id, now);
});

boothRouter.post('/booths/:id/pause', operateBooth, (req, res) => {
  const id = parse(Id, req.params.id);
  const body = parse(PauseBody, req.body);
  tx(() => {
    const booth = getBooth(id)!;
    run(`UPDATE booths SET paused = ? WHERE id = ?`, (body.paused ?? !booth.paused) ? 1 : 0, id);
  });
  const now = Date.now();
  res.json({ booth: stateOf(getBooth(id)!, now) });
  emitBoothChanged(id, now);
});

boothRouter.post('/booths/:id/rounds/next', operateBooth, (req, res) => {
  const id = parse(Id, req.params.id);
  const now = Date.now();
  const result = tx(() => {
    const booth = getBooth(id)!;
    const r = startNextRound(booth, activeTickets(id), boothRounds(id), now);
    if (r.finishRoundId !== null) run(`UPDATE rounds SET status = 'done' WHERE id = ?`, r.finishRoundId);
    for (const tid of r.finishTicketIds) applyPatch(tid, { status: 'done', done_at: now });
    if (!r.newRound) return { ...r, roundId: null };
    const roundId = Number(run(
      `INSERT INTO rounds (booth_id, round_no, status, started_at, ends_at) VALUES (?,?,'seating',?,?)`,
      id, r.newRound.round_no, r.newRound.started_at, r.newRound.ends_at).lastInsertRowid);
    for (const tid of r.seatTicketIds) applyPatch(tid, { status: 'called', called_at: now, round_id: roundId });
    return { ...r, roundId };
  });
  res.json({
    roundId: result.roundId,
    roundNo: result.newRound?.round_no ?? null,
    seatedTicketIds: result.seatTicketIds,
    finishedTicketIds: result.finishTicketIds,
    nextUpTicketIds: result.nextUpTicketIds,
    seatsLeft: result.seatsLeft,
    booth: stateOf(getBooth(id)!, now),
  });
  for (const tid of result.seatTicketIds) emitCalled(tid, now);
  emitBoothChanged(id, now, result.finishTicketIds, { nextRound: result.nextUpTicketIds });
});

boothRouter.post('/tickets/:id/:action(start|done|skip)', operateTicket, (req, res) => {
  const id = parse(Id, req.params.id);
  const action = req.params.action as 'start' | 'done' | 'skip';
  const now = Date.now();
  tx(() => {
    const t = getTicket(id)!;
    const booth = getBooth(t.booth_id)!;
    if (action === 'skip') {
      applyPatch(id, skip(t, activeTickets(booth.id)));
      return;
    }
    applyPatch(id, transition(t, action, now));
    if (action === 'done' && booth.mode === 'live' && t.serving_at !== null) {
      run(`UPDATE booths SET speed_factor = ? WHERE id = ?`,
        learnSpeed(booth.speed_factor, t.serving_at, now, t.base_minutes), booth.id);
    }
  });
  const t = getTicket(id)!;
  const booth = getBooth(t.booth_id)!;
  res.json({ ticket: ticketView(t, booth, activeTickets(booth.id), now), booth: stateOf(booth, now) });
  emitBoothChanged(booth.id, now, [id]);
});
