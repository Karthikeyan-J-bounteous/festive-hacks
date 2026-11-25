// Admin routes (SPEC-LITE §7). S5: quotas + family passes.
import { Router } from 'express';
import { z } from 'zod';
import { tx } from '../db/db';
import { all, one, refreshVip, run } from '../db/queries';
import { requireRole } from '../auth';
import { HttpError, parse } from '../http';
import { ACTIONS } from '../engine/rbac';
import { type Pass, type PassEvent, type Side, assertQuota, generateToken, usedByEvent } from '../engine/passes';
import { emitBoothChanged } from '../socket';

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
