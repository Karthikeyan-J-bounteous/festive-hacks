// Socket.io (SPEC-LITE §7): rooms `wedding:{id}`, `booth:{id}`, `user:{id}`.
// Events: booth:update, ticket:update, ticket:called, event:status, code:rotate.
// Every emit is a no-op until initSocket() runs, so routes and tests work without a server.
import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { SESSION_COOKIE, authFromToken } from './auth';
import { all, activeTickets, boothsForWedding, getBooth, getTicket } from './db/queries';
import { currentCode } from './engine/presence';
import { boothState, boothView, ticketView } from './routes/views';

let io: Server | null = null;

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function initSocket(server: HttpServer): Server {
  io = new Server(server);
  io.use((socket, next) => {
    try {
      socket.data.auth = authFromToken(readCookie(socket.request.headers.cookie, SESSION_COOKIE));
      next();
    } catch {
      next(new Error('unauthenticated'));
    }
  });
  io.on('connection', (socket) => {
    const { userId, weddingId, memberships, handlerBoothIds } = socket.data.auth;
    const isAdmin = memberships.some((m: { role: string }) => m.role === 'admin');
    const boothIds: number[] = isAdmin ? boothsForWedding(weddingId).map((b) => b.id) : handlerBoothIds;
    socket.join([`wedding:${weddingId}`, `user:${userId}`, ...boothIds.map((id) => `booth:${id}`)]);
  });
  return io;
}

/** Test/shutdown hook. */
export function closeSocket(): void {
  io?.close();
  io = null;
}

function guestNames(boothId: number): Map<number, string | null> {
  const rows = all<{ id: number; name: string | null }>(
    `SELECT DISTINCT u.id, u.name FROM users u JOIN tickets t ON t.user_id = u.id
     WHERE t.booth_id = ? AND t.status IN ('waiting','away','called','serving')`, boothId);
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** One ticket's latest state to its owner. `almost` marks the "you're nearly up" nudge. */
export function emitTicket(ticketId: number, now: number, extra: { almost?: boolean } = {}): void {
  if (!io) return;
  const t = getTicket(ticketId);
  const booth = t && getBooth(t.booth_id);
  if (!t || !booth) return;
  io.to(`user:${t.user_id}`).emit('ticket:update', { ticket: ticketView(t, booth, activeTickets(booth.id), now), ...extra });
}

export function emitCalled(ticketId: number, now: number): void {
  if (!io) return;
  const t = getTicket(ticketId);
  const booth = t && getBooth(t.booth_id);
  if (!t || !booth) return;
  io.to(`user:${t.user_id}`).emit('ticket:called', { ticket: ticketView(t, booth, activeTickets(booth.id), now) });
}

/**
 * A booth's queue changed: handlers get the full console state, everyone else the map summary,
 * and every guest still in the line (plus `changedTicketIds`, which may have left it) gets a fresh ETA.
 */
export function emitBoothChanged(boothId: number, now: number, changedTicketIds: readonly number[] = []): void {
  if (!io) return;
  const booth = getBooth(boothId);
  if (!booth) return;
  const tickets = activeTickets(boothId);
  io.to(`booth:${boothId}`).emit('booth:update', { booth: boothState(booth, now, guestNames(boothId)) });
  io.to(`wedding:${booth.wedding_id}`).except(`booth:${boothId}`).emit('booth:update', { booth: boothView(booth, now, tickets) });
  for (const id of new Set([...tickets.map((t) => t.id), ...changedTicketIds])) emitTicket(id, now);
}

export function emitEventStatus(weddingId: number, event: { id: number; type: string; name: string }, live: boolean): void {
  io?.to(`wedding:${weddingId}`).emit('event:status', { eventId: event.id, type: event.type, name: event.name, live });
}

/** The rotating venue code goes only to admins (the venue screen), never to guests. */
export function emitCodeRotate(weddingId: number, secret: string, now: number): void {
  if (!io) return;
  const admins = all<{ user_id: number }>(`SELECT user_id FROM memberships WHERE wedding_id = ? AND role = 'admin'`, weddingId);
  if (admins.length === 0) return;
  const { code, token, expiresAt } = currentCode(secret, now);
  io.to(admins.map((a) => `user:${a.user_id}`)).emit('code:rotate', { code, token, expiresAt });
}
