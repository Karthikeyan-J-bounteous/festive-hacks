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
    <div class="festoon" aria-hidden="true"></div>
    <div class="mx-auto flex min-h-dvh max-w-lg flex-col gap-5 px-4 pb-12 pt-3">
      <header class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="eyebrow">Varisai · Booth</p>
          <h1 class="font-display truncate text-3xl leading-tight text-primary">{{ booth()?.name ?? 'Your booths' }}</h1>
        </div>
        @if (booth(); as b) {
          <button
            class="btn btn-sm shrink-0 rounded-full border-2"
            [class]="b.paused ? 'border-wait-amber bg-wait-amber text-white' : 'border-line bg-surface'"
            [attr.aria-pressed]="b.paused" [disabled]="busy()" (click)="pause(b)">
            {{ b.paused ? '▶ Resume' : '❚❚ Pause' }}
          </button>
        }
      </header>

      @if (booths().length > 1) {
        <nav class="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" aria-label="Your booths">
          @for (b of booths(); track b.id) {
            <button class="chip" [attr.aria-pressed]="b.id === booth()?.id" (click)="pick(b.id)">
              {{ b.name }} <span class="opacity-80">· {{ b.waiting }}</span>
            </button>
          }
        </nav>
      }

      @if (loaded() && booths().length === 0) {
        <div class="card flex flex-col items-center gap-2 p-8 text-center">
          <span class="text-4xl" aria-hidden="true">🪔</span>
          <p class="font-semibold">No booths are assigned to you yet.</p>
          <p class="text-sm opacity-80">Ask the organiser to add your phone number.</p>
        </div>
      }

      @if (booth(); as b) {
        <dl class="grid grid-cols-3 gap-2 text-center">
          <div class="card px-2 py-3">
            <dt class="eyebrow">Waiting</dt>
            <dd class="mt-0.5 text-2xl font-bold tabular-nums">{{ b.waiting }}</dd>
          </div>
          <div class="card px-2 py-3">
            <dt class="eyebrow">New guest</dt>
            <dd class="mt-0.5 text-2xl font-bold tabular-nums">~{{ b.waitMin }}<span class="text-sm font-semibold"> min</span></dd>
          </div>
          <div class="card px-2 py-3">
            <dt class="eyebrow">{{ b.mode === 'live' ? 'Artists' : 'Seats' }}</dt>
            <dd class="mt-0.5 text-2xl font-bold tabular-nums">{{ b.mode === 'live' ? b.artists : b.roundSeats }}</dd>
          </div>
        </dl>
        @if (b.paused) {
          <p class="rounded-xl bg-wait-amber px-4 py-2 text-center text-sm font-semibold text-white" role="status">
            Paused: guests can't join right now.</p>
        }

        @if (b.mode === 'live') {
          <section aria-labelledby="now-title" class="flex flex-col gap-3">
            <h2 id="now-title" class="eyebrow">Now serving</h2>
            @for (t of inProgress(); track t.id) {
              <article class="card overflow-hidden border-2 border-primary">
                <div class="flex items-center justify-between bg-tint px-5 py-4">
                  <p class="font-display text-6xl leading-none text-primary">{{ t.code }}</p>
                  <div class="text-right">
                    <p class="text-3xl font-bold tabular-nums" aria-label="Time since called">{{ timer(t) }}</p>
                    <span class="inline-block rounded-full px-2.5 py-0.5 text-xs font-bold"
                          [class]="t.status === 'called' ? 'bg-accent text-white' : 'bg-primary text-on-primary'">{{ statusText[t.status] }}</span>
                  </div>
                </div>
                <div class="px-5 pb-5 pt-3">
                  <p class="font-semibold">{{ t.guestName ?? 'Guest' }}
                    @if (t.isVip) { <span class="gold-badge ml-1 align-middle">★ Family</span> }</p>
                  <p class="text-sm opacity-80">{{ t.option }}
                    @if (t.partySize > 1) { · {{ t.partySize }} people }
                    @if (t.skipCount) { · skipped once before }</p>
                  <div class="mt-4 grid grid-cols-2 gap-2">
                    @if (t.status === 'called') {
                      <button class="btn btn-primary btn-lg" [disabled]="busy()" (click)="ticketAction(t, 'start')">Start</button>
                      <button class="btn btn-soft btn-lg" [disabled]="busy()" (click)="ticketAction(t, 'skip')">Skip</button>
                    } @else {
                      <button class="btn btn-primary btn-lg col-span-2" [disabled]="busy()" (click)="ticketAction(t, 'done')">✓ Done</button>
                    }
                  </div>
                </div>
              </article>
            } @empty {
              <p class="card border-dashed p-6 text-center opacity-80">Nobody at the counter.</p>
            }
            <button class="btn btn-primary flex-col rounded-2xl py-5 text-xl"
                    [disabled]="busy() || b.paused || inProgress().length >= b.artists || waiting().length === 0"
                    (click)="callNext(b)">
              Call next →
              @if (inProgress().length >= b.artists && waiting().length) {
                <span class="block text-sm font-medium">every artist is busy</span>
              }
            </button>
          </section>
        } @else {
          <section aria-labelledby="round-title" class="card p-5">
            <h2 id="round-title" class="font-display text-2xl text-primary">
              @if (b.round; as r) { Round {{ r.roundNo }} seating } @else { No round seated }
            </h2>
            @if (b.round; as r) {
              <div class="mt-3 flex items-baseline justify-between text-sm">
                <span><strong class="text-2xl tabular-nums">{{ r.seatsUsed }}</strong> / {{ b.roundSeats }} seats · {{ (b.roundSeats ?? 0) - r.seatsUsed }} left</span>
                <span class="font-semibold">ends in {{ minutesLeft(r.endsAt) }} min</span>
              </div>
              <div class="mt-2 h-3.5 overflow-hidden rounded-full bg-tint" role="progressbar"
                   [attr.aria-valuenow]="r.seatsUsed" aria-valuemin="0" [attr.aria-valuemax]="b.roundSeats">
                <div class="h-full rounded-full bg-[linear-gradient(90deg,var(--primary),var(--accent))] transition-[width] duration-500"
                     [style.width.%]="(r.seatsUsed / (b.roundSeats || 1)) * 100"></div>
              </div>
            }
            <p class="mt-3 text-sm opacity-85">Next round seats up to {{ b.roundSeats }}: families stay together, first come first seated.</p>
            <button class="btn btn-primary btn-lg mt-4 w-full"
                    [disabled]="busy() || (waiting().length === 0 && !b.round)" (click)="nextRound(b)">
              Start next round →
            </button>
          </section>
        }

        <section aria-labelledby="next-title">
          <h2 id="next-title" class="eyebrow mb-2">
            {{ b.mode === 'live' ? 'Next 3' : 'Waiting families' }}
          </h2>
          <ol class="card flex flex-col divide-y divide-line overflow-hidden">
            @for (t of (b.mode === 'live' ? waiting().slice(0, 3) : waiting()); track t.id; let i = $index) {
              <li class="flex items-center gap-3 px-4 py-3">
                <span class="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-tint text-sm font-bold">{{ i + 1 }}</span>
                <span class="min-w-0 flex-1 truncate"><strong class="font-display text-lg">{{ t.code }}</strong>
                  <span class="opacity-80"> · {{ t.guestName ?? 'Guest' }}</span></span>
                @if (t.isVip) { <span class="gold-badge">★</span> }
                <span class="text-sm opacity-85">{{ b.mode === 'live' ? t.option : t.partySize + ' seats' }}</span>
              </li>
            } @empty {
              <li class="px-4 py-5 text-center opacity-75">The line is empty.</li>
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
