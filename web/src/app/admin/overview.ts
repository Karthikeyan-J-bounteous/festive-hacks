import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { Api, errorText } from '../core/api';
import { AdminEvent, Booth } from '../core/models';
import { Socket } from '../core/socket';
import { Toast } from '../core/toast';
import { VenueMap, WAIT_BG, boothPin } from '../shared/venue-map';

interface Overview {
  kpis: {
    checkedIn: number;
    activeTickets: number;
    avgWaitMin: number;
    longestQueue: { boothId: number; name: string; waiting: number; waitMin: number } | null;
    passes: { issued: number; used: number };
  };
  events: AdminEvent[];
  booths: Booth[];
  /** Flagsmith eta_style A/B (§14.2); null when Flagsmith has no key. */
  abTest: Record<'minutes' | 'people', { joined: number; cancelled: number; cancelRate: number | null }> | null;
}

/** KPIs + live map with badges (SPEC-LITE §8). Refreshes on booth changes and every 15 s. */
@Component({
  selector: 'app-overview',
  imports: [VenueMap],
  host: { class: 'flex flex-col gap-6' },
  template: `
    @if (data(); as d) {
      <section class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-label="Key numbers">
        @for (k of tiles(); track k.label) {
          <div class="card relative overflow-hidden p-4 pl-5">
            <span class="absolute inset-y-3 left-0 w-1 rounded-r-full bg-[linear-gradient(var(--primary),var(--accent))]" aria-hidden="true"></span>
            <p class="eyebrow">{{ k.label }}</p>
            <p class="mt-1.5 text-3xl font-bold tabular-nums">{{ k.value }}</p>
            @if (k.sub) { <p class="mt-0.5 truncate text-xs opacity-75">{{ k.sub }}</p> }
          </div>
        }
      </section>

      <div class="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <section aria-labelledby="map-title" class="card p-4">
          <h2 id="map-title" class="mb-3 flex items-center gap-2 font-bold">
            <span class="h-2 w-2 rounded-full" [class]="liveNames() ? 'animate-pulse bg-wait-green' : 'bg-wait-grey'" aria-hidden="true"></span>
            Live map
            <span class="text-sm font-normal opacity-75">· {{ liveNames() || 'no event live' }}</span></h2>
          <app-venue-map [pins]="pins()" [dimUnused]="true" />
        </section>
        <section aria-labelledby="booths-title" class="card p-4">
          <h2 id="booths-title" class="mb-2 font-bold">Live booths</h2>
          <ul class="flex flex-col divide-y divide-line">
            @for (b of d.booths; track b.id) {
              <li class="flex items-center justify-between gap-3 py-2.5 text-sm">
                <span class="min-w-0">
                  <span class="block truncate font-semibold">{{ b.name }}</span>
                  <span class="text-xs opacity-75">{{ b.waiting }} waiting</span>
                </span>
                <span class="wait-pill shrink-0" [class]="waitBg[b.colour]">{{ b.paused ? 'Paused' : b.waitMin + ' min' }}</span>
              </li>
            } @empty {
              <li class="py-6 text-center text-sm opacity-75">Nothing is live. Use Events → Go live now.</li>
            }
          </ul>
        </section>
      </div>
    } @else {
      <div class="grid grid-cols-2 gap-3 md:grid-cols-5" aria-hidden="true">
        @for (i of [1, 2, 3, 4, 5]; track i) { <div class="card h-24 animate-pulse bg-tint"></div> }
      </div>
      <p class="sr-only" role="status">Loading…</p>
    }
  `,
})
export class OverviewTab implements OnInit {
  private readonly api = inject(Api);
  private readonly socket = inject(Socket);
  private readonly toast = inject(Toast);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly waitBg = WAIT_BG;
  protected readonly data = signal<Overview | null>(null);
  protected readonly pins = computed(() => (this.data()?.booths ?? []).map(boothPin));
  protected readonly liveNames = computed(() => (this.data()?.events ?? []).filter((e) => e.live).map((e) => e.name).join(', '));
  protected readonly tiles = computed(() => {
    const k = this.data()?.kpis;
    if (!k) return [];
    return [
      { label: 'Checked in', value: k.checkedIn, sub: 'guests at the venue' },
      { label: 'Active tickets', value: k.activeTickets, sub: 'in a queue now' },
      { label: 'Avg wait', value: `${k.avgWaitMin} min`, sub: 'for a new guest' },
      { label: 'Longest queue', value: k.longestQueue ? `${k.longestQueue.waitMin} min` : '—', sub: k.longestQueue?.name ?? '' },
      { label: 'Passes used', value: `${k.passes.used} / ${k.passes.issued}`, sub: 'family passes claimed' },
      ...this.abTile(),
    ];
  });

  /** Cancel rate per ETA wording: "minutes" (~15–20 min) vs "people" (3 people ahead). */
  private abTile() {
    const ab = this.data()?.abTest;
    if (!ab) return [];
    const pct = (r: number | null) => (r === null ? '—' : `${r}%`);
    return [{
      label: 'ETA A/B cancels',
      value: `${pct(ab.minutes.cancelRate)} · ${pct(ab.people.cancelRate)}`,
      sub: `minutes (${ab.minutes.joined}) vs people (${ab.people.joined})`,
    }];
  }

  private pending: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    const poll = setInterval(() => void this.load(), 15_000);
    const offs = [
      this.socket.on('booth:update', () => this.soon()),
      this.socket.on('event:status', () => this.soon()),
      this.socket.onConnect(() => this.soon()),
    ];
    this.destroyRef.onDestroy(() => {
      clearInterval(poll);
      if (this.pending) clearTimeout(this.pending);
      offs.forEach((off) => off());
    });
    void this.load();
  }

  /** Bursts of booth updates → one refetch. */
  private soon(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.load();
    }, 800);
  }

  private async load(): Promise<void> {
    try {
      this.data.set(await this.api.get<Overview>('/api/admin/overview'));
    } catch (e) {
      this.toast.error(errorText(e));
    }
  }
}
