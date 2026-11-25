// NudgeBee (SPEC-LITE §14.3): ops API auth + artist update, and the deduped webhook push.
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../index';
import { db } from '../db/db';
import { ALERT_DEDUPE_MS, OpsAlert, dueAlerts, pushQueueAlerts, resetNudgebeeState } from './nudgebee';

const TOKEN = 'test-ops-token-123';
const mehendi = () => (db.prepare(`SELECT id FROM booths WHERE name = 'Mehendi table'`).get() as { id: number }).id;
const alert = (boothId: number): OpsAlert => ({
  boothId, name: 'B', reason: 'r', estWaitMin: 30, waiting: 5, artists: 1, suggestedArtists: 2,
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetNudgebeeState();
});

describe('ops API', () => {
  it('is 401 when OPS_TOKEN is unset, and with a missing or wrong token', async () => {
    expect((await request(app).get('/api/ops/overview').set('Authorization', `Bearer ${TOKEN}`)).status).toBe(401);
    vi.stubEnv('OPS_TOKEN', TOKEN);
    const none = await request(app).get('/api/ops/overview');
    expect([none.status, none.body.error]).toEqual([401, 'unauthorized']);
    expect((await request(app).get('/api/ops/overview').set('Authorization', 'Bearer nope')).status).toBe(401);
  });

  it('adding an artist lowers the booth wait; alerts list booths over 25 min', async () => {
    vi.stubEnv('OPS_TOKEN', TOKEN);
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const id = mehendi();
    await request(app).post(`/api/ops/booths/${id}/artists`).set(auth).send({ artists: 1 }).expect(200);
    const before = (await request(app).get('/api/ops/overview').set(auth).expect(200)).body;
    const b1 = before.booths.find((b: { id: number }) => b.id === id);
    expect(b1).toMatchObject({ name: 'Mehendi table', event: 'Mehendi', artists: 1 });
    expect(b1.estWaitMin).toBeGreaterThan(25);
    expect(before.alerts.find((a: OpsAlert) => a.boothId === id)).toMatchObject({ suggestedArtists: 2 });

    const after = await request(app).post(`/api/ops/booths/${id}/artists`).set(auth).send({ artists: 3 }).expect(200);
    expect(after.body.booth.artists).toBe(3);
    expect(after.body.booth.estWaitMin).toBeLessThan(b1.estWaitMin);

    const bad = await request(app).post(`/api/ops/booths/${id}/artists`).set(auth).send({ artists: 9 });
    expect([bad.status, bad.body.error]).toEqual([400, 'bad_request']);
  });
});

describe('webhook push', () => {
  it('fires when a booth first crosses, not while it stays over, and at most once per 15 min', () => {
    const t = 1_000_000;
    expect(dueAlerts([alert(1)], t).map((a) => a.boothId)).toEqual([1]);
    expect(dueAlerts([alert(1)], t + 10_000)).toEqual([]);                 // still over
    expect(dueAlerts([], t + 20_000)).toEqual([]);                         // dropped below
    expect(dueAlerts([alert(1)], t + 30_000)).toEqual([]);                 // re-crossed inside 15 min
    dueAlerts([], t + ALERT_DEDUPE_MS);
    expect(dueAlerts([alert(1)], t + ALERT_DEDUPE_MS + 1).map((a) => a.boothId)).toEqual([1]);
  });

  it('sends nothing without NUDGEBEE_WEBHOOK_URL', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(pushQueueAlerts(Date.now())).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
