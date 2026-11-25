import { Injectable, signal } from '@angular/core';
import { io, Socket as IoSocket } from 'socket.io-client';
import { Booth, BoothState, Flags, Ticket } from './models';

/** Server → client events (SPEC-LITE §7). */
export interface ServerEvents {
  'booth:update': { booth: Booth | BoothState };
  'ticket:update': { ticket: Ticket; almost?: boolean; nextRound?: boolean };
  'ticket:called': { ticket: Ticket };
  'event:status': { eventId: number; type: string; name: string; live: boolean };
  'code:rotate': { code: string; token: string; expiresAt: number };
  /** Sarvam (§14.1): the "your turn" line in the guest's language, with base64 MP3 audio. */
  'ticket:voice': { ticketId: number; text: string; audio: string | null };
  /** Sarvam: a translated almost / next-round note. */
  'ticket:note': { ticketId: number; text: string };
  /** Flagsmith: a flag flipped; this user's resolved flags. */
  'flags:update': { flags: Flags };
}

/** One shared socket.io connection; the session cookie authenticates it. */
@Injectable({ providedIn: 'root' })
export class Socket {
  private socket: IoSocket | null = null;
  readonly connected = signal(false);

  private ensure(): IoSocket {
    if (!this.socket) {
      this.socket = io({ withCredentials: true });
      this.socket.on('connect', () => this.connected.set(true));
      this.socket.on('disconnect', () => this.connected.set(false));
    }
    return this.socket;
  }

  /** Subscribe; returns the unsubscribe function (call it in DestroyRef.onDestroy). */
  on<E extends keyof ServerEvents>(event: E, fn: (payload: ServerEvents[E]) => void): () => void {
    const s = this.ensure();
    const name: string = event;
    const handler = fn as (...args: unknown[]) => void;
    s.on(name, handler);
    return () => s.off(name, handler);
  }

  /** Call after the session changes (login, new handler booth) so the server re-joins rooms. */
  reconnect(): void {
    if (!this.socket) return;
    this.socket.disconnect();
    this.socket.connect();
  }

  /** Fires after every (re)connect, so screens can refetch what they missed. */
  onConnect(fn: () => void): () => void {
    const s = this.ensure();
    s.on('connect', fn);
    return () => s.off('connect', fn);
  }
}
