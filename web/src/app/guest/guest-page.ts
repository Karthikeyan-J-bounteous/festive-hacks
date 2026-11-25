import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Api, errorText } from '../core/api';
import { Bootstrap, Booth, Ticket } from '../core/models';
import { Socket } from '../core/socket';
import { ThemeService } from '../core/theme.service';
import { themeFor } from '../core/themes';
import { Toast } from '../core/toast';
import { session } from '../shared/motion';
import { VenueMap, boothPin } from '../shared/venue-map';
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

    <div class="themed mx-auto flex min-h-dvh max-w-lg flex-col gap-4 px-4 pb-10 pt-4">
      <header class="flex items-center justify-between gap-3">
        <div>
          <p class="text-xs uppercase tracking-widest opacity-75">Varisai</p>
          <h1 class="font-display text-2xl text-primary">{{ boot()?.wedding?.couple_names ?? '…' }}</h1>
        </div>
        @if (boot()?.pass; as pass) {
          <span class="rounded-full bg-gold px-3 py-1 text-xs font-bold text-white" [title]="pass.label">★ Family pass</span>
        }
      </header>

      @if (loadError()) {
        <p class="rounded-xl bg-surface p-4" role="alert">{{ loadError() }}
          <button class="ml-2 underline" (click)="load()">Retry</button></p>
      }

      @if (boot() && !boot()!.presence.valid) {
        <section class="rounded-2xl bg-surface p-4 shadow-sm" aria-labelledby="presence-title">
          <h2 id="presence-title" class="font-semibold">Are you at the venue?</h2>
          <p class="mt-1 text-sm opacity-80">We check once so only guests in the hall can join queues.</p>
          <button class="mt-3 w-full rounded-xl bg-primary px-4 py-3 font-bold text-on-primary disabled:opacity-60"
                  [disabled]="presenceBusy()" (click)="useLocation()">
            {{ presenceBusy() ? 'Checking…' : 'Allow location' }}
          </button>
          <form class="mt-3 flex gap-2" (ngSubmit)="useCode()">
            <label class="sr-only" for="venue-code">4-digit code on the venue screen</label>
            <input id="venue-code" name="code" inputmode="numeric" maxlength="8" [(ngModel)]="code"
                   placeholder="Enter the 4-digit code on the venue screen"
                   class="min-w-0 flex-1 rounded-xl border border-text/20 bg-bg px-3 py-2 text-sm" />
            <button class="rounded-xl border-2 border-primary px-4 py-2 text-sm font-bold text-primary"
                    [disabled]="presenceBusy() || code.trim().length < 4">Verify</button>
          </form>
        </section>
      }

      @if (events().length > 1) {
        <nav class="flex gap-2 overflow-x-auto pb-1" aria-label="Live events">
          @for (e of events(); track e.id) {
            <button
              class="shrink-0 rounded-full border-2 px-4 py-1.5 text-sm font-semibold"
              [class]="e.id === currentEvent()?.id ? 'border-primary bg-primary text-on-primary' : 'border-text/20'"
              [attr.aria-pressed]="e.id === currentEvent()?.id" (click)="selectEvent(e.id)">
              {{ e.name }}
              @if (ticketCount(e.id); as n) { <span class="ml-1 opacity-80">· {{ n }}</span> }
            </button>
          }
        </nav>
      } @else if (currentEvent(); as e) {
        <p class="font-display text-xl">{{ e.name }} <span class="text-sm font-sans opacity-75">is on now</span></p>
      }

      @if (boot() && events().length === 0) {
        <p class="rounded-2xl bg-surface p-6 text-center">No event is live right now. We'll update this screen when one starts.</p>
      }

      @if (currentEvent()) {
        <section aria-label="Venue map">
          <app-venue-map [pins]="pins()" [dimUnused]="true" [selectedId]="selected()?.id ?? null"
                         (boothClick)="selectedId.set($event)" />
          <p class="mt-2 text-center text-xs opacity-75">Tap a booth to see the wait and join.</p>
        </section>
      }

      @if (myTickets().length) {
        <section aria-label="Your queues">
          <h2 class="mb-2 text-sm font-semibold uppercase tracking-wide opacity-80">Your queues ({{ myTickets().length }}/3)</h2>
          <div class="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2">
            @for (t of myTickets(); track t.id) {
              <app-ticket-card class="w-64 shrink-0 snap-start" [ticket]="t" [isBatch]="boothOf(t)?.mode === 'batch'"
                               [note]="notes()[t.id] ?? ''" [busy]="busyId() === t.id" (act)="act(t, $event)" />
            }
          </div>
        </section>
      }

      @if (currentEvent()) {
        <ul class="flex flex-col gap-2" aria-label="Booths">
          @for (b of eventBooths(); track b.id) {
            <li>
              <button class="flex w-full items-center justify-between rounded-xl bg-surface px-4 py-3 text-left shadow-sm"
                      (click)="selectedId.set(b.id)">
                <span class="font-medium">{{ b.name }}</span>
                <span class="text-sm">{{ b.paused ? 'Paused' : '~' + b.waitMin + ' min' }} · {{ b.waiting }} waiting</span>
              </button>
            </li>
          }
        </ul>
      }
    </div>

    @if (selected(); as b) {
      <app-booth-sheet [booth]="b" [mine]="ticketAt(b.id)" [presenceValid]="!!boot()?.presence?.valid"
                       [ticketsInEvent]="ticketCount(b.eventId)" [busy]="joining()"
                       (join)="join(b, $event)" (close)="selectedId.set(null)" />
    }

    @if (takeover(); as t) {
      <app-takeover [ticket]="t" (dismiss)="takeover.set(null)" />
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
