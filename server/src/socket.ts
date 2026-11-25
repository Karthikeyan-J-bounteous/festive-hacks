// Socket.io (SPEC-LITE §7): rooms `wedding:{id}`, `booth:{id}`, `user:{id}`.
// Events: booth:update, ticket:update, ticket:called, event:status, code:rotate,
// plus Sarvam's ticket:voice {ticketId, text, audio} and ticket:note {ticketId, text},
// and Flagsmith's flags:update {flags} (per user, since eta_style is per identity).
// Every emit is a no-op until initSocket() runs, so routes and tests work without a server.
import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { SESSION_COOKIE, authFromToken } from './auth';
import { all, activeTickets, boothsForWedding, getBooth, getTicket, one } from './db/queries';
import { Lang, asLang, sarvamEnabled, translate, voiceLine } from './sponsors/sarvam';
import { FlagsChange, flag, flagsOf } from './sponsors/flags';
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

/**
 * One ticket's latest state to its owner. `almost` marks the "you're nearly up" nudge;
 * `nextRound` marks "you're in the next feast round".
 */
export function emitTicket(ticketId: number, now: number, extra: { almost?: boolean; nextRound?: boolean } = {}): void {
  if (!io) return;
  const t = getTicket(ticketId);
  const booth = t && getBooth(t.booth_id);
  if (!t || !booth) return;
  io.to(`user:${t.user_id}`).emit('ticket:update', { ticket: ticketView(t, booth, activeTickets(booth.id), now), ...extra });
  if (extra.almost) {
    translateNote(t.user_id, t.id, NOTE_ALMOST);
    warmTurn(t.user_id, booth.name, t.code); // so the "your turn" audio is cached before the call
  } else if (extra.nextRound) translateNote(t.user_id, t.id, NOTE_NEXT_ROUND);
}

export function emitCalled(ticketId: number, now: number): void {
  if (!io) return;
  const t = getTicket(ticketId);
  const booth = t && getBooth(t.booth_id);
  if (!t || !booth) return;
  io.to(`user:${t.user_id}`).emit('ticket:called', { ticket: ticketView(t, booth, activeTickets(booth.id), now) });
  announceTurn(t.user_id, t.id, booth.name, t.code);
}

// ---- Sarvam (§14.1). Fire-and-forget after the commit; never blocks or fails the action. ----
// The English notes match the web's built-in copy; only non-English guests get a ticket:note.
const NOTE_ALMOST = 'Almost your turn, start walking over.';
const NOTE_NEXT_ROUND = "You're in the next feast round.";

function guestLang(userId: number): { name: string | null; lang: Lang } {
  const u = one<{ name: string | null; lang: string }>(`SELECT name, lang FROM users WHERE id = ?`, userId);
  return { name: u?.name ?? null, lang: asLang(u?.lang) };
}

function turnLine(userId: number, boothName: string, code: string): Promise<{ text: string; audio: string | null }> {
  const { name, lang } = guestLang(userId);
  return voiceLine(`${name ? `${name}, it` : 'It'}'s your turn at ${boothName}. Token ${code}.`, lang);
}

const voiceOn = (): boolean => sarvamEnabled() && flag('voice_alerts');

function announceTurn(userId: number, ticketId: number, boothName: string, code: string): void {
  if (!voiceOn()) return;
  void turnLine(userId, boothName, code).then((v) => io?.to(`user:${userId}`).emit('ticket:voice', { ticketId, ...v }));
}

function warmTurn(userId: number, boothName: string, code: string): void {
  if (voiceOn()) void turnLine(userId, boothName, code);
}

function translateNote(userId: number, ticketId: number, english: string): void {
  if (!sarvamEnabled()) return;
  const { lang } = guestLang(userId);
  if (lang === 'en-IN') return;
  void translate(english, lang).then((text) => {
    if (text !== english) io?.to(`user:${userId}`).emit('ticket:note', { ticketId, text });
  });
}

/**
 * A booth's queue changed: handlers get the full console state, everyone else the map summary,
 * and every guest still in the line (plus `changedTicketIds`, which may have left it) gets a fresh ETA.
 * Tickets in `opts.nextRound` get that update flagged `nextRound: true`.
 */
export function emitBoothChanged(
  boothId: number, now: number, changedTicketIds: readonly number[] = [], opts: { nextRound?: readonly number[] } = {},
): void {
  if (!io) return;
  const booth = getBooth(boothId);
  if (!booth) return;
  const tickets = activeTickets(boothId);
  io.to(`booth:${boothId}`).emit('booth:update', { booth: boothState(booth, now, guestNames(boothId)) });
  io.to(`wedding:${booth.wedding_id}`).except(`booth:${boothId}`).emit('booth:update', { booth: boothView(booth, now, tickets) });
  const nextRound = new Set(opts.nextRound);
  for (const id of new Set([...tickets.map((t) => t.id), ...changedTicketIds])) {
    emitTicket(id, now, nextRound.has(id) ? { nextRound: true } : {});
  }
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

// ---- Flagsmith (§14.2) ----

/** Users with an open socket (for refreshing their A/B variant). */
export function connectedUserIds(): number[] {
  if (!io) return [];
  return [...new Set([...io.sockets.sockets.values()].map((s) => s.data.auth?.userId as number).filter(Boolean))];
}

/** A flag flipped: every connected user gets their flags; a VIP-lane flip also reorders every live line. */
export function emitFlags(change: FlagsChange, now: number): void {
  if (!io) return;
  const kill = (Object.keys(change.after) as (keyof typeof change.after)[]).some(
    (k) => k !== 'eta_style' && change.after[k] !== change.before[k]);
  const envStyle = change.after.eta_style !== change.before.eta_style;
  const targets = kill || envStyle ? connectedUserIds() : change.users;
  for (const id of targets) io.to(`user:${id}`).emit('flags:update', { flags: flagsOf(id) });
  if (change.after.family_passes !== change.before.family_passes) {
    const booths = all<{ booth_id: number }>(
      `SELECT DISTINCT booth_id FROM tickets WHERE status IN ('waiting','away','called','serving')`);
    for (const { booth_id } of booths) emitBoothChanged(booth_id, now);
  }
}
