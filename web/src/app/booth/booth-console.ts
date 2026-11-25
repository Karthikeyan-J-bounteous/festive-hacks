import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { Api, errorText } from '../core/api';
import { BoothState, QueueEntry } from '../core/models';
import { Socket } from '../core/socket';
import { ThemeService } from '../core/theme.service';
import { Toast } from '../core/toast';
import { session } from '../shared/motion';

const STATUS_TEXT: Record<string, string> = { called: 'Called', serving: 'Serving', waiting: 'Waiting', away: 'Away' };

/** Handler console `/booth` (SPEC-LITE §8): switcher, Now serving + timer, Next 3, actions, pause, feast rounds. */
@Component({
  selector: 'app-booth-console',
  template: `
    <div class="mx-auto flex min-h-dvh max-w-lg flex-col gap-4 px-4 pb-10 pt-4">
      <header class="flex items-center justify-between">
        <div>
          <p class="text-xs uppercase tracking-widest opacity-75">Varisai · Booth</p>
          <h1 class="font-display text-2xl text-primary">{{ booth()?.name ?? 'Your booths' }}</h1>
        </div>
        @if (booth(); as b) {
          <button
            class="rounded-full border-2 px-4 py-2 text-sm font-bold"
            [class]="b.paused ? 'border-text bg-text text-bg' : 'border-text/25'"
            [attr.aria-pressed]="b.paused" [disabled]="busy()" (click)="pause(b)">
            {{ b.paused ? 'Paused · Resume' : 'Pause' }}
          </button>
        }
      </header>

      @if (booths().length > 1) {
        <nav class="flex gap-2 overflow-x-auto pb-1" aria-label="Your booths">
          @for (b of booths(); track b.id) {
            <button class="shrink-0 rounded-full border-2 px-4 py-1.5 text-sm font-semibold"
                    [class]="b.id === booth()?.id ? 'border-primary bg-primary text-on-primary' : 'border-text/20'"
                    [attr.aria-pressed]="b.id === booth()?.id" (click)="pick(b.id)">
              {{ b.name }} <span class="opacity-80">· {{ b.waiting }}</span>
            </button>
          }
        </nav>
      }

      @if (loaded() && booths().length === 0) {
        <p class="rounded-2xl bg-surface p-6 text-center">No booths are assigned to you yet. Ask the organiser.</p>
      }

      @if (booth(); as b) {
        <p class="text-sm opacity-80">
          {{ b.waiting }} waiting · ~{{ b.waitMin }} min for a new guest
          @if (b.mode === 'live') { · {{ b.artists }} {{ b.artists === 1 ? 'artist' : 'artists' }} }
        </p>

        @if (b.mode === 'live') {
          <section aria-labelledby="now-title" class="flex flex-col gap-3">
            <h2 id="now-title" class="text-sm font-semibold uppercase tracking-wide opacity-80">Now serving</h2>
            @for (t of inProgress(); track t.id) {
              <article class="rounded-2xl border-2 border-primary bg-surface p-5 shadow">
                <div class="flex items-baseline justify-between">
                  <p class="font-display text-5xl text-primary">{{ t.code }}</p>
                  <p class="text-2xl font-bold tabular-nums" aria-label="Time since called">{{ timer(t) }}</p>
                </div>
                <p class="mt-1">{{ t.guestName ?? 'Guest' }} · {{ t.option }}
                  @if (t.partySize > 1) { · {{ t.partySize }} people }
                  @if (t.isVip) { · ★ Family }</p>
                <p class="text-sm opacity-80">{{ statusText[t.status] }}
                  @if (t.skipCount) { · skipped once before }</p>
                <div class="mt-4 grid grid-cols-2 gap-2">
                  @if (t.status === 'called') {
                    <button class="rounded-xl bg-primary py-3 text-lg font-bold text-on-primary" [disabled]="busy()"
                            (click)="ticketAction(t, 'start')">Start</button>
                    <button class="rounded-xl border-2 border-text/30 py-3 text-lg font-bold" [disabled]="busy()"
                            (click)="ticketAction(t, 'skip')">Skip</button>
                  } @else {
                    <button class="col-span-2 rounded-xl bg-primary py-3 text-lg font-bold text-on-primary" [disabled]="busy()"
                            (click)="ticketAction(t, 'done')">Done</button>
                  }
                </div>
              </article>
            } @empty {
              <p class="rounded-2xl bg-surface p-5 text-center opacity-80">Nobody at the counter.</p>
            }
            <button class="rounded-2xl bg-primary py-5 text-xl font-bold text-on-primary shadow disabled:opacity-50"
                    [disabled]="busy() || b.paused || inProgress().length >= b.artists || waiting().length === 0"
                    (click)="callNext(b)">
              Call next
              @if (inProgress().length >= b.artists && waiting().length) {
                <span class="block text-sm font-medium">every artist is busy</span>
              }
            </button>
          </section>
        } @else {
          <section aria-labelledby="round-title" class="rounded-2xl bg-surface p-5 shadow-sm">
            <h2 id="round-title" class="font-semibold">
              @if (b.round; as r) { Round {{ r.roundNo }} seating } @else { No round seated }
            </h2>
            @if (b.round; as r) {
              <p class="mt-1 text-sm">{{ r.seatsUsed }} / {{ b.roundSeats }} seats used · {{ (b.roundSeats ?? 0) - r.seatsUsed }} left ·
                ends in {{ minutesLeft(r.endsAt) }} min</p>
              <div class="mt-2 h-3 overflow-hidden rounded-full bg-bg" role="progressbar"
                   [attr.aria-valuenow]="r.seatsUsed" aria-valuemin="0" [attr.aria-valuemax]="b.roundSeats">
                <div class="h-full bg-primary" [style.width.%]="(r.seatsUsed / (b.roundSeats || 1)) * 100"></div>
              </div>
            }
            <p class="mt-3 text-sm">Next round seats up to {{ b.roundSeats }}: families stay together, first come first seated.</p>
            <button class="mt-4 w-full rounded-xl bg-primary py-4 text-lg font-bold text-on-primary disabled:opacity-50"
                    [disabled]="busy() || (waiting().length === 0 && !b.round)" (click)="nextRound(b)">
              Start next round
            </button>
          </section>
        }

        <section aria-labelledby="next-title">
          <h2 id="next-title" class="mb-2 text-sm font-semibold uppercase tracking-wide opacity-80">
            {{ b.mode === 'live' ? 'Next 3' : 'Waiting families' }}
          </h2>
          <ol class="flex flex-col gap-2">
            @for (t of (b.mode === 'live' ? waiting().slice(0, 3) : waiting()); track t.id; let i = $index) {
              <li class="flex items-center justify-between rounded-xl bg-surface px-4 py-3 shadow-sm">
                <span><span class="mr-2 opacity-60">{{ i + 1 }}.</span><strong>{{ t.code }}</strong> · {{ t.guestName ?? 'Guest' }}</span>
                <span class="text-sm">
                  @if (t.isVip) { <span class="font-bold text-gold">★</span> }
                  {{ b.mode === 'live' ? t.option : t.partySize + ' seats' }}
                </span>
              </li>
            } @empty {
              <li class="rounded-xl bg-surface px-4 py-3 text-center opacity-75">The line is empty.</li>
            }
          </ol>
          @if (away().length) {
            <p class="mt-2 text-sm opacity-75">{{ away().length }} away (place held 20 min)</p>
          }
        </section>
      }
    </div>
  `,
})
export class BoothConsole implements OnInit {
  private readonly api = inject(Api);
  private readonly socket = inject(Socket);
  private readonly toast = inject(Toast);
  private readonly theme = inject(ThemeService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly booths = signal<BoothState[]>([]);
  protected readonly loaded = signal(false);
  protected readonly selectedId = signal<number | null>(Number(session.get('varisai.booth')) || null);
  protected readonly busy = signal(false);
  protected readonly now = signal(Date.now());
  protected readonly statusText = STATUS_TEXT;

  protected readonly booth = computed(() => {
    const all = this.booths();
    return all.find((b) => b.id === this.selectedId()) ?? all[0] ?? null;
  });
  protected readonly inProgress = computed(() =>
    (this.booth()?.queue ?? []).filter((t) => t.status === 'called' || t.status === 'serving'));
  protected readonly waiting = computed(() => (this.booth()?.queue ?? []).filter((t) => t.status === 'waiting'));
  protected readonly away = computed(() => (this.booth()?.queue ?? []).filter((t) => t.status === 'away'));

  ngOnInit(): void {
    this.theme.apply(null);
    const tick = setInterval(() => this.now.set(Date.now()), 1000);
    const offs = [
      this.socket.on('booth:update', ({ booth }) => {
        if ('queue' in booth) this.replace(booth);
      }),
      this.socket.onConnect(() => void this.load()),
    ];
    this.destroyRef.onDestroy(() => {
      clearInterval(tick);
      offs.forEach((off) => off());
    });
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.booths.set((await this.api.get<{ booths: BoothState[] }>('/api/booth/booths')).booths);
    } catch (e) {
      this.toast.error(errorText(e));
    } finally {
      this.loaded.set(true);
    }
  }

  protected pick(id: number): void {
    this.selectedId.set(id);
    session.set('varisai.booth', String(id));
  }

  protected timer(t: QueueEntry): string {
    const since = t.servingAt ?? t.calledAt ?? this.now();
    const s = Math.max(0, Math.floor((this.now() - since) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  protected minutesLeft(endsAt: number): number {
    return Math.max(0, Math.ceil((endsAt - this.now()) / 60_000));
  }

  protected callNext(b: BoothState): Promise<void> {
    return this.run<{ booth: BoothState; ticket: { code: string } }>(`/api/booth/booths/${b.id}/call-next`, (r) =>
      this.toast.show(`Called ${r.ticket.code}`));
  }
  protected pause(b: BoothState): Promise<void> {
    return this.run(`/api/booth/booths/${b.id}/pause`, () => {}, { paused: !b.paused });
  }
  protected nextRound(b: BoothState): Promise<void> {
    return this.run<{ booth: BoothState; roundNo: number | null; seatedTicketIds: number[] }>(
      `/api/booth/booths/${b.id}/rounds/next`, (r) =>
      this.toast.show(r.roundNo ? `Round ${r.roundNo}: ${r.seatedTicketIds.length} families seated` : 'Round closed'));
  }
  protected ticketAction(t: QueueEntry, action: 'start' | 'done' | 'skip'): Promise<void> {
    return this.run(`/api/booth/tickets/${t.id}/${action}`, () => {
      if (action === 'skip') this.toast.show(`${t.code} skipped, moved back 3`);
    });
  }

  private async run<R extends { booth: BoothState }>(url: string, after: (r: R) => void, body: unknown = {}): Promise<void> {
    this.busy.set(true);
    try {
      const r = await this.api.post<R>(url, body);
      this.replace(r.booth);
      after(r);
    } catch (e) {
      this.toast.error(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }

  private replace(booth: BoothState): void {
    this.booths.update((all) => all.map((b) => (b.id === booth.id ? booth : b)));
  }
}
