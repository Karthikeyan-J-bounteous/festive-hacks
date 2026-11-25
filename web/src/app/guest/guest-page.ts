import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Api, errorText } from '../core/api';
import { Bootstrap, Booth, Ticket } from '../core/models';
import { Socket } from '../core/socket';
import { ThemeService } from '../core/theme.service';
import { themeFor } from '../core/themes';
import { Toast } from '../core/toast';
import { VOICE_LANGS, Voice } from '../core/voice';
import { session } from '../shared/motion';
import { VenueMap, WAIT_BG, boothPin } from '../shared/venue-map';
import { BoothSheet } from './booth-sheet';
import { Splash } from './splash';
import { Takeover } from './takeover';
import { TicketCard } from './ticket-card';

const ENDED = new Set(['done', 'no_show', 'cancelled']);
const ENDED_TEXT: Record<string, string> = {
  done: 'All done, enjoy!',
  no_show: 'was released because you did not come in time',
  cancelled: 'was cancelled',
};

/** Guest home `/w` (SPEC-LITE §8): presence → map with event chips → booth sheet → ticket tray → takeover. */
@Component({
  selector: 'app-guest-page',
  imports: [FormsModule, VenueMap, BoothSheet, TicketCard, Splash, Takeover],
  template: `
    @if (splash() && boot(); as b) {
      <app-splash [couple]="b.wedding.couple_names" [eventName]="currentEvent()?.name ?? b.wedding.name"
                  [kind]="splashKind()" (done)="endSplash()" />
    }

    <div class="festoon" aria-hidden="true"></div>
    <div class="themed mx-auto flex min-h-dvh max-w-lg flex-col gap-5 px-4 pb-12 pt-3">
      <header class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="eyebrow">Varisai</p>
          <h1 class="font-display truncate text-3xl leading-tight text-primary">{{ boot()?.wedding?.couple_names ?? '…' }}</h1>
        </div>
        @if (boot()?.pass; as pass) {
          <span class="gold-badge shrink-0" [title]="pass.label">★ Family pass</span>
        }
      </header>

      @if (loadError()) {
        <p class="card flex items-center justify-between gap-3 p-4" role="alert">
          <span>{{ loadError() }}</span>
          <button class="btn btn-soft btn-sm" (click)="load()">Retry</button></p>
      }

      @if (boot() && !boot()!.presence.valid) {
        <section class="card overflow-hidden" aria-labelledby="presence-title">
          <div class="flex items-start gap-3 bg-tint p-4">
            <span class="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary text-lg text-on-primary" aria-hidden="true">📍</span>
            <div>
              <h2 id="presence-title" class="font-bold">Are you at the venue?</h2>
              <p class="mt-0.5 text-sm opacity-80">We check once so only guests in the hall can join queues.</p>
            </div>
          </div>
          <div class="flex flex-col gap-3 p-4">
            <button class="btn btn-primary w-full" [disabled]="presenceBusy()" (click)="useLocation()">
              {{ presenceBusy() ? 'Checking…' : 'Allow location' }}
            </button>
            <div class="flex items-center gap-3 text-xs opacity-70" aria-hidden="true">
              <span class="h-px flex-1 bg-line"></span>or<span class="h-px flex-1 bg-line"></span>
            </div>
            <form class="flex gap-2" (ngSubmit)="useCode()">
              <label class="sr-only" for="venue-code">4-digit code on the venue screen</label>
              <input id="venue-code" name="code" inputmode="numeric" maxlength="8" [(ngModel)]="code"
                     placeholder="Code on the venue screen"
                     class="input min-w-0 flex-1 text-center font-mono tracking-[0.3em]" />
              <button class="btn btn-outline" [disabled]="presenceBusy() || code.trim().length < 4">Verify</button>
            </form>
          </div>
        </section>
      }

      <!-- Sarvam (§14.1): alert language + one-tap audio unlock. Hidden when the server has no key. -->
      @if (boot()?.voice) {
        <div class="card flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
          <label class="flex items-center gap-2 text-sm font-semibold" for="alert-lang">
            <span aria-hidden="true">🔊</span> Alerts in</label>
          <select id="alert-lang" class="input input-sm w-auto font-semibold" [ngModel]="boot()!.lang"
                  (ngModelChange)="setLang($event)" [disabled]="langBusy()">
            @for (l of langs; track l.code) { <option [value]="l.code">{{ l.label }}</option> }
          </select>
          @if (voice.unlocked()) {
            <span class="ml-auto inline-flex items-center gap-1.5 text-xs font-semibold">
              <span class="h-2 w-2 rounded-full bg-wait-green" aria-hidden="true"></span>Voice on</span>
          } @else {
            <button class="btn btn-primary btn-sm ml-auto" (click)="voice.unlock()">Enable voice alerts</button>
          }
        </div>
      }

      @if (events().length > 1) {
        <nav class="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" aria-label="Live events">
          @for (e of events(); track e.id) {
            <button class="chip" [attr.aria-pressed]="e.id === currentEvent()?.id" (click)="selectEvent(e.id)">
              {{ e.name }}
              @if (ticketCount(e.id); as n) {
                <span class="grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-xs text-white">{{ n }}</span>
              }
            </button>
          }
        </nav>
      } @else if (currentEvent(); as e) {
        <p class="flex items-baseline gap-2">
          <span class="font-display text-2xl">{{ e.name }}</span>
          <span class="inline-flex items-center gap-1.5 text-sm opacity-80">
            <span class="h-2 w-2 animate-pulse rounded-full bg-wait-green" aria-hidden="true"></span>on now</span>
        </p>
      }

      @if (boot() && events().length === 0) {
        <div class="card flex flex-col items-center gap-2 p-8 text-center">
          <span class="text-4xl" aria-hidden="true">🪔</span>
          <p class="font-display text-xl text-primary">Nothing is live yet</p>
          <p class="text-sm opacity-80">We'll update this screen the moment the next event starts.</p>
        </div>
      }

      @if (myTickets().length) {
        <section aria-labelledby="tray-title">
          <h2 id="tray-title" class="eyebrow mb-2">Your queues · {{ myTickets().length }}/3</h2>
          <div class="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-3">
            @for (t of myTickets(); track t.id) {
              <app-ticket-card class="w-68 shrink-0 snap-start" [ticket]="t" [isBatch]="boothOf(t)?.mode === 'batch'"
                               [note]="notes()[t.id] ?? ''" [busy]="busyId() === t.id" (act)="act(t, $event)" />
            }
          </div>
        </section>
      }

      @if (currentEvent()) {
        <section class="card p-2" aria-label="Venue map">
          <app-venue-map [pins]="pins()" [dimUnused]="true" [selectedId]="selected()?.id ?? null"
                         (boothClick)="selectedId.set($event)" />
          <p class="py-1.5 text-center text-xs opacity-75">Tap a booth to see the wait and join</p>
        </section>

        <section aria-labelledby="booths-title">
          <h2 id="booths-title" class="eyebrow mb-2">Booths</h2>
          <ul class="card flex flex-col divide-y divide-line overflow-hidden">
            @for (b of eventBooths(); track b.id) {
              <li>
                <button class="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-tint"
                        (click)="selectedId.set(b.id)">
                  <span class="min-w-0 flex-1">
                    <span class="block truncate font-semibold">{{ b.name }}</span>
                    <span class="block text-xs opacity-75">{{ b.waiting }} waiting
                      @if (ticketAt(b.id); as t) { · <strong class="text-primary">you're {{ t.code }}</strong> }</span>
                  </span>
                  <span class="wait-pill" [class]="waitBg[b.colour]">{{ b.paused ? 'Paused' : '~' + b.waitMin + ' min' }}</span>
                  <span class="text-lg opacity-40" aria-hidden="true">›</span>
                </button>
              </li>
            }
          </ul>
        </section>
      }
    </div>

    @if (selected(); as b) {
      <app-booth-sheet [booth]="b" [mine]="ticketAt(b.id)" [presenceValid]="!!boot()?.presence?.valid"
                       [ticketsInEvent]="ticketCount(b.eventId)" [busy]="joining()"
                       (join)="join(b, $event)" (close)="selectedId.set(null)" />
    }

    @if (takeover(); as t) {
      <app-takeover [ticket]="t" [voice]="voices()[t.id] ?? null" (dismiss)="takeover.set(null)" />
    }
  `,
})
export class GuestPage implements OnInit {
  private readonly api = inject(Api);
  private readonly socket = inject(Socket);
  private readonly theme = inject(ThemeService);
  private readonly toast = inject(Toast);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly boot = signal<Bootstrap | null>(null);
  protected readonly loadError = signal('');
  protected readonly voice = inject(Voice);
  protected readonly langs = VOICE_LANGS;
  protected readonly langBusy = signal(false);
  /** Sarvam "your turn" lines by ticket id. */
  protected readonly voices = signal<Record<number, { text: string; audio: string | null }>>({});
  protected readonly waitBg = WAIT_BG;
  protected readonly splash = signal(session.get('varisai.splash') !== '1');
  protected readonly eventId = signal<number | null>(null);
  protected readonly selectedId = signal<number | null>(null);
  protected readonly takeover = signal<Ticket | null>(null);
  protected readonly notes = signal<Record<number, string>>({});
  protected readonly presenceBusy = signal(false);
  protected readonly joining = signal(false);
  protected readonly busyId = signal<number | null>(null);
  protected code = '';

  protected readonly events = computed(() => this.boot()?.events ?? []);
  protected readonly currentEvent = computed(() => {
    const evs = this.events();
    return evs.find((e) => e.id === this.eventId()) ?? evs[0] ?? null;
  });
  protected readonly splashKind = computed(() => themeFor(this.currentEvent()?.type).splash);
  protected readonly eventBooths = computed(() =>
    (this.boot()?.booths ?? []).filter((b) => b.eventId === this.currentEvent()?.id));
  protected readonly pins = computed(() => this.eventBooths().map(boothPin));
  protected readonly selected = computed(() => this.eventBooths().find((b) => b.id === this.selectedId()) ?? null);
  protected readonly myTickets = computed(() =>
    (this.boot()?.tickets ?? []).filter((t) => t.eventId === this.currentEvent()?.id));

  ngOnInit(): void {
    const offs = [
      this.socket.on('booth:update', ({ booth }) => this.patchBooth(booth)),
      this.socket.on('ticket:update', (p) => this.onTicket(p.ticket, p)),
      this.socket.on('ticket:called', ({ ticket }) => this.onTicket(ticket, {})),
      this.socket.on('ticket:voice', (v) => {
        this.voices.update((m) => ({ ...m, [v.ticketId]: { text: v.text, audio: v.audio } })); // takeover plays it
      }),
      this.socket.on('ticket:note', ({ ticketId, text }) => this.note(ticketId, text)),
      this.socket.on('event:status', (e) => {
        this.toast.show(e.live ? `${e.name} is live now!` : `${e.name} has ended`);
        void this.load();
      }),
      this.socket.onConnect(() => void this.load()),
    ];
    this.destroyRef.onDestroy(() => offs.forEach((off) => off()));
    void this.start();
  }

  private async start(): Promise<void> {
    await this.load();
    // Scanned the venue QR: /w?code=<token> verifies presence in one step.
    const code = this.route.snapshot.queryParamMap.get('code');
    if (code) {
      void this.router.navigate([], { queryParams: {}, replaceUrl: true });
      if (!this.boot()?.presence.valid) await this.verify({ code });
    }
  }

  async load(): Promise<void> {
    try {
      const b = await this.api.get<Bootstrap>('/api/guest/bootstrap');
      this.loadError.set('');
      this.boot.set(b);
      this.theme.apply(this.currentEvent()?.type ?? null);
      const called = b.tickets.find((t) => t.status === 'called' && !this.seenCalled.has(t.id));
      if (called) this.showTakeover(called);
    } catch (e) {
      this.loadError.set(errorText(e));
    }
  }

  protected endSplash(): void {
    session.set('varisai.splash', '1');
    this.splash.set(false);
  }

  protected selectEvent(id: number): void {
    this.eventId.set(id);
    this.selectedId.set(null);
    this.theme.apply(this.currentEvent()?.type ?? null); // 400 ms cross-fade via CSS
  }

  protected ticketCount(eventId: number): number {
    return (this.boot()?.tickets ?? []).filter((t) => t.eventId === eventId).length;
  }
  protected ticketAt(boothId: number): Ticket | null {
    return this.boot()?.tickets.find((t) => t.boothId === boothId) ?? null;
  }
  protected boothOf(t: Ticket): Booth | undefined {
    return this.boot()?.booths.find((b) => b.id === t.boothId);
  }

  protected async setLang(lang: string): Promise<void> {
    const before = this.boot()?.lang;
    this.boot.update((b) => b && { ...b, lang });
    this.langBusy.set(true);
    try {
      await this.api.put('/api/guest/lang', { lang });
    } catch (e) {
      this.boot.update((b) => b && before ? { ...b, lang: before } : b);
      this.toast.error(errorText(e));
    } finally {
      this.langBusy.set(false);
    }
  }

  // ---- presence ----
  protected useLocation(): void {
    if (!navigator.geolocation) {
      this.toast.error('Location is not available, use the venue code instead');
      return;
    }
    this.presenceBusy.set(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => void this.verify({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      () => {
        this.presenceBusy.set(false);
        this.toast.error('Could not get your location, enter the code on the venue screen');
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }
  protected useCode(): void {
    void this.verify({ code: this.code.trim() });
  }
  private async verify(body: { code: string } | { lat: number; lng: number; accuracy: number }): Promise<void> {
    this.presenceBusy.set(true);
    try {
      const r = await this.api.post<{ valid: boolean; validUntil: number }>('/api/guest/presence', body);
      this.boot.update((b) => b && { ...b, presence: { valid: r.valid, validUntil: r.validUntil } });
      this.code = '';
      this.toast.show("You're checked in. Pick a booth!");
    } catch (e) {
      this.toast.error(errorText(e));
    } finally {
      this.presenceBusy.set(false);
    }
  }

  // ---- tickets ----
  protected async join(b: Booth, choice: { option: string; partySize: number }): Promise<void> {
    this.joining.set(true);
    try {
      const { ticket } = await this.api.post<{ ticket: Ticket }>('/api/guest/tickets', { boothId: b.id, ...choice });
      this.upsertTicket(ticket);
      this.selectedId.set(null);
      this.toast.show(`You're in! Your code is ${ticket.code}`);
    } catch (e) {
      this.toast.error(errorText(e));
    } finally {
      this.joining.set(false);
    }
  }

  protected async act(t: Ticket, action: 'away' | 'back' | 'cancel'): Promise<void> {
    if (action === 'cancel' && !confirm(`Leave the ${t.boothName} queue?`)) return;
    this.busyId.set(t.id);
    try {
      const { ticket } = await this.api.post<{ ticket: Ticket }>(`/api/guest/tickets/${t.id}/${action}`);
      this.upsertTicket(ticket);
    } catch (e) {
      this.toast.error(errorText(e));
    } finally {
      this.busyId.set(null);
    }
  }

  private readonly seenCalled = new Set<number>();

  private onTicket(ticket: Ticket, extra: { almost?: boolean; nextRound?: boolean }): void {
    const before = this.boot()?.tickets.find((t) => t.id === ticket.id);
    this.upsertTicket(ticket);
    if (ENDED.has(ticket.status) && before) {
      this.toast.show(ticket.status === 'done' ? ENDED_TEXT['done'] : `${ticket.code} ${ENDED_TEXT[ticket.status]}`);
      return;
    }
    if (ticket.status === 'called' && !this.seenCalled.has(ticket.id)) this.showTakeover(ticket);
    if (before && before.skipCount < ticket.skipCount && ticket.status === 'waiting') {
      this.note(ticket.id, 'You missed your turn, so you moved back 3 places.');
    } else if (extra.almost) {
      this.note(ticket.id, 'Almost your turn, start walking over.');
      navigator.vibrate?.(200);
    } else if (extra.nextRound) {
      this.note(ticket.id, "You're in the next feast round.");
    }
  }

  private showTakeover(t: Ticket): void {
    this.seenCalled.add(t.id);
    this.takeover.set(t);
  }

  private note(id: number, text: string): void {
    this.notes.update((n) => ({ ...n, [id]: text }));
  }

  private upsertTicket(ticket: Ticket): void {
    this.boot.update((b) => {
      if (!b) return b;
      const rest = b.tickets.filter((t) => t.id !== ticket.id);
      return { ...b, tickets: ENDED.has(ticket.status) ? rest : [...rest, ticket].sort((x, y) => x.joinedAt - y.joinedAt) };
    });
  }

  private patchBooth(booth: Booth): void {
    this.boot.update((b) => {
      if (!b || !b.booths.some((x) => x.id === booth.id)) return b;
      const { id, eventId, name, serviceType, mode, x, y, options, artists, paused, roundSeats, roundMinutes,
        waiting, inProgress, waitMin, colour } = booth;
      const summary: Booth = { id, eventId, name, serviceType, mode, x, y, options, artists, paused, roundSeats,
        roundMinutes, waiting, inProgress, waitMin, colour };
      return { ...b, booths: b.booths.map((x) => (x.id === booth.id ? summary : x)) };
    });
  }
}
