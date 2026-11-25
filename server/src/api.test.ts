// HTTP tests (SPEC-LITE §10 supertest cases). Runs against a fresh seeded in-memory DB.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from './index';
import { db } from './db/db';
import { currentCode } from './engine/presence';

const OTP = '123456';

async function login(phone: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/verify').send({ phone, otp: OTP }).expect(200);
  return agent;
}
const boothId = (name: string) =>
  (db.prepare('SELECT id FROM booths WHERE name = ?').get(name) as { id: number }).id;

describe('auth', () => {
  it('rejects a wrong OTP and an unauthenticated /api/me', async () => {
    const bad = await request(app).post('/api/auth/verify').send({ phone: '9000000001', otp: '000000' });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('bad_otp');
    expect((await request(app).get('/api/me')).status).toBe(401);
  });

  it.each([
    ['9000000001', 'admin', '/admin'],
    ['9000000010', 'booth_handler', '/booth'],
    ['9000000105', 'guest', '/w'],
  ])('seeded %s (%s) lands on %s', async (phone, role, home) => {
    const me = await (await login(phone)).get('/api/me').expect(200);
    expect(me.body.home).toBe(home);
    expect(me.body.memberships.map((m: { role: string }) => m.role)).toContain(role);
  });
});

describe('booth routes', () => {
  it('handler cannot operate an unassigned booth', async () => {
    const meena = await login('9000000010'); // assigned to Mehendi table, Nail art, Chaat
    const res = await meena.post(`/api/booth/booths/${boothId('Dining hall')}/rounds/next`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('handler calls next at an assigned booth; a guest cannot', async () => {
    const meena = await login('9000000010');
    const res = await meena.post(`/api/booth/booths/${boothId('Nail art')}/call-next`).expect(200);
    expect(res.body.ticket.status).toBe('called');
    const guest = await login('9000000105');
    expect((await guest.post(`/api/booth/booths/${boothId('Nail art')}/call-next`)).status).toBe(403);
  });
});

describe('feast rounds', () => {
  it('next round seats the waiting families, closes the old round, then refuses an empty hall', async () => {
    const ravi = await login('9000000011'); // feast handler
    const dining = boothId('Dining hall');
    const next = () => ravi.post(`/api/booth/booths/${dining}/rounds/next`);
    const status = (ids: number[]) => ids.map((id) =>
      (db.prepare('SELECT status FROM tickets WHERE id = ?').get(id) as { status: string }).status);

    const r1 = await next().expect(200);
    expect(r1.body.roundNo).toBe(5);
    expect(r1.body.seatedTicketIds).toHaveLength(5);  // 4+6+3+5+2 = 20 of 40 seats
    expect(r1.body.finishedTicketIds).toHaveLength(5); // round 4's diners
    expect(status(r1.body.seatedTicketIds)).toEqual(Array(5).fill('called'));
    expect(status(r1.body.finishedTicketIds)).toEqual(Array(5).fill('done'));
    expect(r1.body.booth.round).toMatchObject({ roundNo: 5, seatsUsed: 20 });

    const r2 = await next().expect(200); // nobody waiting: just closes round 5
    expect(r2.body).toMatchObject({ roundId: null, roundNo: null, seatedTicketIds: [] });
    expect(r2.body.booth.round).toBeNull();

    const r3 = await next();
    expect(r3.status).toBe(409);
    expect(r3.body.error).toBe('queue_empty');
  });

  it('call-next is refused at a feast booth', async () => {
    const ravi = await login('9000000011');
    const res = await ravi.post(`/api/booth/booths/${boothId('Dining hall')}/call-next`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_live_booth');
  });
});

describe('guest routes', () => {
  it('guest without presence gets 403 on join, then joins after the venue code', async () => {
    const guest = await login('9000000999'); // new phone → guest membership, no presence
    const join = () => guest.post('/api/guest/tickets').send({ boothId: boothId('Chaat counter'), option: 'Pani puri' });
    const denied = await join();
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('presence_required');

    const secret = (db.prepare('SELECT qr_secret FROM weddings').get() as { qr_secret: string }).qr_secret;
    await guest.post('/api/guest/presence').send({ code: currentCode(secret, Date.now()).code }).expect(200);
    const ok = await join().expect(201);
    expect(ok.body.ticket.code).toMatch(/^C-\d{3}$/);
  });

  it('duplicate join is 409', async () => {
    const guest = await login('9000000106');
    const body = { boothId: boothId('Chaat counter'), option: 'Full plate' };
    await guest.post('/api/guest/tickets').send(body).expect(201);
    const dup = await guest.post('/api/guest/tickets').send(body);
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('duplicate');
  });

  it('4th ticket in one event is rejected', async () => {
    const mehendiEvent = (db.prepare(`SELECT id FROM events WHERE type = 'mehendi'`).get() as { id: number }).id;
    const extra = Number(db.prepare(
      `INSERT INTO booths (event_id, name, service_type, code_prefix, mode, options_json) VALUES (?,?,?,?,?,?)`,
    ).run(mehendiEvent, 'Photo booth', 'photo', 'P', 'live', JSON.stringify([{ label: 'Photo', minutes: 2 }])).lastInsertRowid);

    const guest = await login('9000000109'); // already at Nail art + Chaat
    await guest.post('/api/guest/tickets').send({ boothId: boothId('Mehendi table'), option: 'Palm only' }).expect(201);
    const fourth = await guest.post('/api/guest/tickets').send({ boothId: extra, option: 'Photo' });
    expect(fourth.status).toBe(409);
    expect(fourth.body.error).toBe('max_tickets');
  });

  it('bad body is a 400 with the {error, message} shape', async () => {
    const guest = await login('9000000105');
    const res = await guest.post('/api/guest/tickets').send({ boothId: 'x' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request', message: expect.any(String) });
  });

  it('revoked pass cannot be claimed', async () => {
    db.prepare(
      `INSERT INTO family_passes (wedding_id, side, token, label, revoked_at) VALUES (1, 'bride', 'revoked-token-1', 'Old pass', ?)`,
    ).run(Date.now());
    const guest = await login('9000000108');
    const res = await guest.post('/api/guest/passes/claim').send({ token: 'revoked-token-1' });
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('pass_invalid');
  });

  it('claiming a pass makes queued tickets VIP; revoking clears it', async () => {
    const admin = await login('9000000001');
    const mehendi = (db.prepare(`SELECT id FROM events WHERE type = 'mehendi'`).get() as { id: number }).id;
    const created = await admin.post('/api/admin/passes').send({ side: 'groom', label: 'Test cousin', eventIds: [mehendi] }).expect(201);
    const token = created.body.pass.url.replace('/p/', '');

    const guest = await login('9000000109'); // seeded, no pass, waiting at mehendi booths
    const vipAt = (userPhone: string) => db.prepare(
      `SELECT t.is_vip FROM tickets t JOIN users u ON u.id = t.user_id
       WHERE u.phone = ? AND t.event_id = ? AND t.status IN ('waiting','away')`).all(userPhone, mehendi)
      .map((r) => (r as { is_vip: number }).is_vip);
    expect(vipAt('9000000109').length).toBeGreaterThan(0);
    expect(vipAt('9000000109').every((v) => v === 0)).toBe(true);

    const claim = await guest.post('/api/guest/passes/claim').send({ token }).expect(200);
    expect(claim.body.pass.side).toBe('groom');
    expect(vipAt('9000000109').every((v) => v === 1)).toBe(true);
    await guest.post('/api/guest/passes/claim').send({ token }).expect(200); // idempotent

    await admin.post(`/api/admin/passes/${created.body.pass.id}/revoke`).expect(200);
    expect(vipAt('9000000109').every((v) => v === 0)).toBe(true);
  });

  it('bootstrap returns live events, booths with waits and my tickets', async () => {
    const res = await (await login('9000000100')).get('/api/guest/bootstrap').expect(200);
    expect(res.body.events.map((e: { type: string }) => e.type)).toEqual(['mehendi', 'feast']);
    expect(res.body.booths.length).toBeGreaterThan(0);
    expect(res.body.tickets.some((t: { isVip: boolean }) => t.isVip)).toBe(true);
    expect(res.body.pass.side).toBe('bride');
  });
});

describe('admin passes and quotas', () => {
  it('41st bride pass is rejected; revoking one frees the slot', async () => {
    const admin = await login('9000000001');
    const quotas = (await admin.get('/api/admin/quotas').expect(200)).body.quotas;
    const sangeet = quotas.find((q: { type: string }) => q.type === 'sangeet') ?? quotas[0];
    expect(sangeet.bride.max).toBe(40);
    const make = (i: number) => admin.post('/api/admin/passes').send({ side: 'bride', label: `Aunty ${i}`, eventIds: [sangeet.eventId] });

    let last;
    for (let i = sangeet.bride.used; i < 40; i++) last = await make(i).expect(201);
    const over = await make(41);
    expect(over.status).toBe(409);
    expect(over.body.error).toBe('quota_exceeded');
    expect((await admin.get('/api/admin/quotas')).body.quotas
      .find((q: { eventId: number }) => q.eventId === sangeet.eventId).bride.used).toBe(40);

    await admin.post(`/api/admin/passes/${last!.body.pass.id}/revoke`).expect(200);
    await make(42).expect(201);
  });

  it('PUT quotas updates max; guests cannot manage passes', async () => {
    const admin = await login('9000000001');
    const [first] = (await admin.get('/api/admin/quotas')).body.quotas;
    const res = await admin.put('/api/admin/quotas').send({ quotas: [{ eventId: first.eventId, side: 'groom', max: 30 }] }).expect(200);
    expect(res.body.quotas[0].groom.max).toBe(30);
    const guest = await login('9000000105');
    expect((await guest.get('/api/admin/passes')).status).toBe(403);
    expect((await guest.post('/api/admin/passes').send({ side: 'bride', label: 'x', eventIds: [first.eventId] })).status).toBe(403);
  });
});

describe('admin events, booths, overview, venue code', () => {
  it('creates an event, forces it live, then ending it cancels its open tickets', async () => {
    const admin = await login('9000000001');
    const now = Date.now();
    const ev = (await admin.post('/api/admin/events')
      .send({ type: 'sangeet', name: 'After-party', startsAt: now + 48 * 3600_000, endsAt: now + 50 * 3600_000 })
      .expect(201)).body.event;
    expect(ev.live).toBe(false);
    expect((await admin.post(`/api/admin/events/${ev.id}/live`).send({ override: 'live' }).expect(200)).body.event.live).toBe(true);
    const bad = await admin.patch(`/api/admin/events/${ev.id}`).send({ endsAt: 1 });
    expect(bad.status).toBe(400);

    const booth = (await admin.post('/api/admin/booths')
      .send({ eventId: ev.id, name: 'Dhol corner', serviceType: 'music', mode: 'live', options: [{ label: 'Beat', minutes: 2 }] })
      .expect(201)).body.booth;
    expect(booth.codePrefix).toBe('D');
    const guest = await login('9000000105');
    await guest.post('/api/guest/presence').send({ code: currentCode(
      (db.prepare('SELECT qr_secret FROM weddings').get() as { qr_secret: string }).qr_secret, Date.now()).code }).expect(200);
    const t = (await guest.post('/api/guest/tickets').send({ boothId: booth.id, option: 'Beat' }).expect(201)).body.ticket;
    expect(t.code).toMatch(/^D-/);

    await admin.post(`/api/admin/events/${ev.id}/live`).send({ override: 'ended' }).expect(200);
    expect((db.prepare('SELECT status FROM tickets WHERE id = ?').get(t.id) as { status: string }).status).toBe('cancelled');
  });

  it('batch booth needs round fields; prefix clash is 409; pin and handler assignment work', async () => {
    const admin = await login('9000000001');
    const [ev] = (await admin.get('/api/admin/events')).body.events;
    const base = { eventId: ev.id, name: 'Tiffin', serviceType: 'feast', options: [{ label: 'Seat', minutes: 20 }] };
    expect((await admin.post('/api/admin/booths').send({ ...base, mode: 'batch' })).status).toBe(400);
    expect((await admin.post('/api/admin/booths').send({ ...base, mode: 'live', codePrefix: 'M' })).body.error).toBe('prefix_taken');

    const id = boothId('Nail art');
    const pinned = await admin.patch(`/api/admin/booths/${id}/pin`).send({ x_pct: 61.5, y_pct: 12 }).expect(200);
    expect([pinned.body.booth.x, pinned.body.booth.y]).toEqual([61.5, 12]);
    expect((await admin.patch(`/api/admin/booths/${id}/pin`).send({ x_pct: 120, y_pct: 0 })).status).toBe(400);

    const assigned = await admin.post(`/api/admin/booths/${id}/handlers`).send({ phone: '9000000777' }).expect(201);
    expect(assigned.body.booth.handlers.map((h: { phone: string }) => h.phone)).toContain('9000000777');
    const newHandler = await login('9000000777');
    expect((await newHandler.get('/api/me')).body.home).toBe('/booth');
    await newHandler.post(`/api/booth/booths/${id}/pause`).expect(200);
  });

  it('overview KPIs and venue code are admin-only', async () => {
    const admin = await login('9000000001');
    const o = (await admin.get('/api/admin/overview').expect(200)).body;
    expect(o.kpis.activeTickets).toBeGreaterThan(0);
    expect(o.kpis.longestQueue).toHaveProperty('name');
    expect(o.kpis.passes.used).toBeLessThanOrEqual(o.kpis.passes.issued);
    const v = (await admin.get('/api/admin/venue-code').expect(200)).body;
    expect(v.code).toMatch(/^\d{4}$/);
    expect(v.expiresAt).toBeGreaterThan(Date.now());

    const meena = await login('9000000010');
    for (const path of ['/api/admin/overview', '/api/admin/venue-code', '/api/admin/events', '/api/admin/booths']) {
      expect((await meena.get(path)).status).toBe(403);
    }
  });
});
