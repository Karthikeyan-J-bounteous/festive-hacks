import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, errorText } from '../core/api';
import { AdminBooth, AdminEvent, BoothOption } from '../core/models';
import { Toast } from '../core/toast';
import { MapPin, VenueMap } from '../shared/venue-map';

interface NewBooth {
  eventId: number | null;
  name: string;
  serviceType: string;
  mode: 'live' | 'batch';
  artists: number;
  roundSeats: number;
  roundMinutes: number;
  options: BoothOption[];
}
const blankBooth = (eventId: number | null): NewBooth => ({
  eventId, name: '', serviceType: '', mode: 'live', artists: 1, roundSeats: 40, roundMinutes: 25,
  options: [{ label: '', minutes: 10 }],
});

/** Layout: map + booth list; select a booth, click the map to place it; handlers; add a booth (SPEC-LITE §4, §8). */
@Component({
  selector: 'app-layout-tab',
  imports: [FormsModule, VenueMap],
  host: { class: 'grid gap-6 lg:grid-cols-[2fr_1fr]' },
  template: `
    <section class="rounded-2xl bg-surface p-4 shadow-sm" aria-labelledby="layout-map-title">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="layout-map-title" class="font-semibold">Venue map</h2>
        <label class="text-sm">Event
          <select class="ml-1 rounded-lg border border-text/20 bg-bg px-2 py-1" [ngModel]="eventId()" (ngModelChange)="pickEvent($event)">
            @for (e of events(); track e.id) { <option [ngValue]="e.id">{{ e.name }}</option> }
          </select></label>
      </div>
      <p class="mb-2 text-sm" aria-live="polite">
        @if (selected(); as b) { Click the map to move <strong>{{ b.name }}</strong>. }
        @else { Pick a booth on the right, then click the map to place its pin. }
      </p>
      <app-venue-map [pins]="pins()" [selectedId]="selectedId()" [placing]="!!selected()"
                     (boothClick)="selectedId.set($event)" (place)="place($event)" />
    </section>

    <aside class="flex flex-col gap-4">
      <section class="rounded-2xl bg-surface p-4 shadow-sm" aria-labelledby="booth-list-title">
        <h2 id="booth-list-title" class="mb-2 font-semibold">Booths</h2>
        <ul class="flex flex-col gap-1">
          @for (b of eventBooths(); track b.id) {
            <li>
              <button class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left"
                      [class]="b.id === selectedId() ? 'bg-primary text-on-primary' : 'hover:bg-bg'"
                      [attr.aria-pressed]="b.id === selectedId()" (click)="selectedId.set(b.id)">
                <span class="font-medium">{{ b.name }}</span>
                <span class="text-xs opacity-80">{{ b.codePrefix }}-… · {{ b.mode }}</span>
              </button>
            </li>
          } @empty { <li class="text-sm opacity-75">No booths for this event yet.</li> }
        </ul>
      </section>

      @if (selected(); as b) {
        <section class="rounded-2xl bg-surface p-4 shadow-sm" aria-labelledby="booth-detail-title">
          <h2 id="booth-detail-title" class="font-semibold">{{ b.name }}</h2>
          <p class="text-sm opacity-80">Pin at {{ b.x }}%, {{ b.y }}% ·
            {{ b.mode === 'live' ? b.artists + ' artist(s)' : b.roundSeats + ' seats / ' + b.roundMinutes + ' min rounds' }}</p>
          @if (b.mode === 'live') {
            <label class="mt-3 flex items-center justify-between text-sm">Artists
              <input type="number" min="1" max="20" class="w-20 rounded-lg border border-text/20 bg-bg px-2 py-1"
                     [ngModel]="b.artists" (change)="setArtists(b, $any($event.target).value)" /></label>
          }
          <h3 class="mt-4 text-sm font-semibold">Handlers</h3>
          <ul class="mt-1 text-sm">
            @for (h of b.handlers; track h.userId) { <li>{{ h.name ?? 'New handler' }} · {{ h.phone }}</li> }
            @empty { <li class="opacity-75">Nobody assigned.</li> }
          </ul>
          <form class="mt-2 flex gap-2" (ngSubmit)="addHandler(b)">
            <label class="sr-only" for="handler-phone">Handler phone</label>
            <input id="handler-phone" name="phone" type="tel" placeholder="Phone number" [(ngModel)]="handlerPhone"
                   class="min-w-0 flex-1 rounded-lg border border-text/20 bg-bg px-3 py-1.5 text-sm" />
            <button class="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-on-primary" [disabled]="busy()">Assign</button>
          </form>
        </section>
      }

      <section class="rounded-2xl bg-surface p-4 shadow-sm" aria-labelledby="add-booth-title">
        <h2 id="add-booth-title" class="font-semibold">Add a booth</h2>
        <form class="mt-2 flex flex-col gap-2 text-sm" (ngSubmit)="create()">
          <input name="name" placeholder="Name, e.g. Henna corner" required [(ngModel)]="draft.name"
                 aria-label="Booth name" class="rounded-lg border border-text/20 bg-bg px-3 py-1.5" />
          <input name="serviceType" placeholder="Service, e.g. mehendi" required [(ngModel)]="draft.serviceType"
                 aria-label="Service type" class="rounded-lg border border-text/20 bg-bg px-3 py-1.5" />
          <div class="flex gap-3" role="radiogroup" aria-label="Mode">
            <label><input type="radio" name="mode" value="live" [(ngModel)]="draft.mode" /> Live queue</label>
            <label><input type="radio" name="mode" value="batch" [(ngModel)]="draft.mode" /> Feast rounds</label>
          </div>
          @if (draft.mode === 'live') {
            <label class="flex items-center justify-between">Artists
              <input name="artists" type="number" min="1" max="20" [(ngModel)]="draft.artists"
                     class="w-20 rounded-lg border border-text/20 bg-bg px-2 py-1" /></label>
          } @else {
            <label class="flex items-center justify-between">Seats per round
              <input name="roundSeats" type="number" min="1" [(ngModel)]="draft.roundSeats"
                     class="w-20 rounded-lg border border-text/20 bg-bg px-2 py-1" /></label>
            <label class="flex items-center justify-between">Minutes per round
              <input name="roundMinutes" type="number" min="1" [(ngModel)]="draft.roundMinutes"
                     class="w-20 rounded-lg border border-text/20 bg-bg px-2 py-1" /></label>
          }
          <fieldset class="flex flex-col gap-1">
            <legend class="font-medium">Options</legend>
            @for (o of draft.options; track $index; let i = $index) {
              <div class="flex gap-2">
                <input [name]="'opt' + i" placeholder="Label" [(ngModel)]="o.label" [attr.aria-label]="'Option ' + (i + 1) + ' label'"
                       class="min-w-0 flex-1 rounded-lg border border-text/20 bg-bg px-2 py-1" />
                <input [name]="'min' + i" type="number" min="1" [(ngModel)]="o.minutes" [attr.aria-label]="'Option ' + (i + 1) + ' minutes'"
                       class="w-16 rounded-lg border border-text/20 bg-bg px-2 py-1" />
                @if (draft.options.length > 1) {
                  <button type="button" (click)="draft.options.splice(i, 1)" [attr.aria-label]="'Remove option ' + (i + 1)">×</button>
                }
              </div>
            }
            <button type="button" class="self-start underline" (click)="draft.options.push({ label: '', minutes: 10 })">+ option</button>
          </fieldset>
          <button class="mt-1 rounded-xl bg-primary px-4 py-2 font-semibold text-on-primary" [disabled]="busy()">Add booth</button>
        </form>
      </section>
    </aside>
  `,
})
export class LayoutTab implements OnInit {
  private readonly api = inject(Api);
  private readonly toast = inject(Toast);

  protected readonly events = signal<AdminEvent[]>([]);
  protected readonly booths = signal<AdminBooth[]>([]);
  protected readonly eventId = signal<number | null>(null);
  protected readonly selectedId = signal<number | null>(null);
  protected readonly busy = signal(false);
  protected handlerPhone = '';
  protected draft: NewBooth = blankBooth(null);

  protected readonly eventBooths = computed(() => this.booths().filter((b) => b.eventId === this.eventId()));
  protected readonly selected = computed(() => this.eventBooths().find((b) => b.id === this.selectedId()) ?? null);
  protected readonly pins = computed<MapPin[]>(() =>
    this.eventBooths().map((b) => ({ id: b.id, name: b.name, x: b.x, y: b.y, colour: b.colour, label: b.codePrefix })));

  async ngOnInit(): Promise<void> {
    try {
      const [{ events }] = await Promise.all([
        this.api.get<{ events: AdminEvent[] }>('/api/admin/events'),
        this.loadBooths(),
      ]);
      this.events.set(events);
      this.pickEvent((events.find((e) => e.live) ?? events[0])?.id ?? null);
    } catch (e) {
      this.toast.error(errorText(e));
    }
  }

  private async loadBooths(): Promise<void> {
    this.booths.set((await this.api.get<{ booths: AdminBooth[] }>('/api/admin/booths')).booths);
  }

  protected pickEvent(id: number | null): void {
    this.eventId.set(id);
    this.selectedId.set(null);
    this.draft.eventId = id;
  }

  protected place(pos: { x: number; y: number }): Promise<void> {
    const b = this.selected();
    if (!b) return Promise.resolve();
    // Move the pin at once; the server answer confirms it.
    this.booths.update((all) => all.map((x) => (x.id === b.id ? { ...x, x: pos.x, y: pos.y } : x)));
    return this.run(() => this.api.patch<{ booth: AdminBooth }>(`/api/admin/booths/${b.id}/pin`, { x_pct: pos.x, y_pct: pos.y }));
  }

  protected setArtists(b: AdminBooth, value: string): Promise<void> {
    return this.run(() => this.api.patch<{ booth: AdminBooth }>(`/api/admin/booths/${b.id}`, { artists: Number(value) }));
  }

  protected addHandler(b: AdminBooth): Promise<void> {
    const phone = this.handlerPhone.replace(/[\s-]/g, '');
    return this.run(async () => {
      const r = await this.api.post<{ booth: AdminBooth }>(`/api/admin/booths/${b.id}/handlers`, { phone });
      this.handlerPhone = '';
      this.toast.show(`${phone} can now log in and run ${b.name}`);
      return r;
    });
  }

  protected create(): Promise<void> {
    const d = this.draft;
    const body = {
      eventId: d.eventId, name: d.name.trim(), serviceType: d.serviceType.trim(), mode: d.mode,
      options: d.options.filter((o) => o.label.trim()).map((o) => ({ label: o.label.trim(), minutes: Number(o.minutes) })),
      ...(d.mode === 'live'
        ? { artists: Number(d.artists) }
        : { roundSeats: Number(d.roundSeats), roundMinutes: Number(d.roundMinutes) }),
    };
    return this.run(async () => {
      const r = await this.api.post<{ booth: AdminBooth }>('/api/admin/booths', body);
      this.draft = blankBooth(this.eventId());
      this.selectedId.set(r.booth.id);
      this.toast.show(`${r.booth.name} added. Click the map to place it.`);
      return r;
    });
  }

  /** Run a call that returns the changed booth, and swap it into the list. */
  private async run(fn: () => Promise<{ booth: AdminBooth }>): Promise<void> {
    this.busy.set(true);
    try {
      const { booth } = await fn();
      this.booths.update((all) => (all.some((b) => b.id === booth.id) ? all.map((b) => (b.id === booth.id ? booth : b)) : [...all, booth]));
    } catch (e) {
      this.toast.error(errorText(e));
      await this.loadBooths().catch(() => {});
    } finally {
      this.busy.set(false);
    }
  }
}
