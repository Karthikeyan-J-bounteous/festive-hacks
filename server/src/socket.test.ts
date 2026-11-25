// Socket wiring: cookie auth on the handshake, rooms, and emits after a booth action.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { io as connect, Socket } from 'socket.io-client';
import { app } from './index';
import { db } from './db/db';
import { closeSocket, initSocket } from './socket';

let server: http.Server;
let url: string;
const sockets: Socket[] = [];

async function cookieFor(phone: string): Promise<string> {
  const res = await request(app).post('/api/auth/verify').send({ phone, otp: '123456' }).expect(200);
  return (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
}
function open(cookie?: string): Socket {
  const s = connect(url, { transports: ['websocket'], extraHeaders: cookie ? { cookie } : {}, reconnection: false });
  sockets.push(s);
  return s;
}
const once = <T>(s: Socket, event: string) => new Promise<T>((resolve) => s.once(event, resolve));

beforeAll(async () => {
  server = http.createServer(app);
  initSocket(server);
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  sockets.forEach((s) => s.close());
  closeSocket();
  server.close();
});

describe('socket', () => {
  it('rejects a handshake without a session', async () => {
    const err = await once<Error>(open(), 'connect_error');
    expect(err.message).toBe('unauthenticated');
  });

  it('call-next sends ticket:called to the guest and booth:update with the queue to the handler', async () => {
    const nailArt = (db.prepare(`SELECT id FROM booths WHERE name = 'Nail art'`).get() as { id: number }).id;
    const handlerCookie = await cookieFor('9000000010');
    const guest = open(await cookieFor('9000000105')); // first in line at Nail art
    const handler = open(handlerCookie);
    await Promise.all([once(guest, 'connect'), once(handler, 'connect')]);

    const called = once<{ ticket: { boothId: number; status: string } }>(guest, 'ticket:called');
    const boothUpdate = once<{ booth: { id: number; queue: unknown[] } }>(handler, 'booth:update');
    await request(app).post(`/api/booth/booths/${nailArt}/call-next`).set('Cookie', handlerCookie).expect(200);

    expect((await called).ticket).toMatchObject({ boothId: nailArt, status: 'called' });
    const update = await boothUpdate;
    expect(update.booth.id).toBe(nailArt);
    expect(Array.isArray(update.booth.queue)).toBe(true);
  });

  it('next feast round sends ticket:called to a seated guest', async () => {
    const dining = (db.prepare(`SELECT id FROM booths WHERE name = 'Dining hall'`).get() as { id: number }).id;
    const handlerCookie = await cookieFor('9000000011');
    const guest = open(await cookieFor('9000000106')); // party of 6 waiting at the Dining hall
    await once(guest, 'connect');

    const called = once<{ ticket: { boothId: number; status: string; roundId: number } }>(guest, 'ticket:called');
    const res = await request(app).post(`/api/booth/booths/${dining}/rounds/next`).set('Cookie', handlerCookie).expect(200);

    expect((await called).ticket).toMatchObject({ boothId: dining, status: 'called', roundId: res.body.roundId });
  });
});
