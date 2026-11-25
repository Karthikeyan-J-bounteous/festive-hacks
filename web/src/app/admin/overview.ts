import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { Api, errorText } from '../core/api';
import { AdminEvent, Booth } from '../core/models';
import { Socket } from '../core/socket';
import { Toast } from '../core/toast';
import { VenueMap, boothPin } from '../shared/venue-map';

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
}

/** KPIs + live map with badges (SPEC-LITE §8). Refreshes on booth changes and every 15 s. */
@Component({
  selector: 'app-overview',
  imports: [VenueMap],
  host: { class: 'flex flex-col gap-6' },
  template: `
    @if (data(); as d) {
      <section class="grid grid-cols-2 gap-3 md:grid-cols-5" aria-label="Key numbers">
        @for (k of tiles(); track k.label) {
          <div class="rounded-2xl bg-surface p-4 shadow-sm">
            <p class="text-sm opacity-75">{{ k.label }}</p>
            <p class="mt-1 text-3xl font-bold tabular-nums">{{ k.value }}</p>
            @if (k.sub) { <p class="text-xs opacity-75">{{ k.sub }}</p> }
          </div>
        }
      </section>

      <div class="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <section aria-labelledby="map-title" class="rounded-2xl bg-surface p-4 shadow-sm">
          <h2 id="map-title" class="mb-3 font-semibold">Live map
            <span class="text-sm font-normal opacity-75">· {{ liveNames() || 'no event live' }}</span></h2>
          <app-venue-map [pins]="pins()" [dimUnused]="true" />
        </section>
        <section aria-labelledby="booths-title" class="rounded-2xl bg-surface p-4 shadow-sm">
          <h2 id="booths-title" class="mb-3 font-semibold">Live booths</h2>
          <ul class="flex flex-col divide-y divide-text/10">
            @for (b of d.booths; track b.id) {
              <li class="flex items-center justify-between py-2 text-sm">
                <span>{{ b.name }}</span>
                <span class="tabular-nums">{{ b.paused ? 'Paused' : b.waitMin + ' min' }} · {{ b.waiting }} waiting</span>
              </li>
            } @empty {
              <li class="py-2 text-sm opacity-75">Nothing is live. Use Events → Go live.</li>
            }
          </ul>
        </section>
      </div>
    } @else {
      <p class="opacity-75">Loading…</p>
    }
  `,
})
export class OverviewTab implements OnInit {
  private readonly api = inject(Api);
  private readonly socket = inject(Socket);
  private readonly toast = inject(Toast);
  private readonly destroyRef = inject(DestroyRef);

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
    ];
  });

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
