import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, errorText } from '../core/api';
import { AdminEvent } from '../core/models';
import { THEMES, themeFor } from '../core/themes';
import { Toast } from '../core/toast';

const HOUR = 3_600_000;
const pad = (n: number) => String(n).padStart(2, '0');
/** epoch ms → value for <input type="datetime-local"> (local time). */
function toLocal(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocal = (v: string) => new Date(v).getTime();

interface Draft { id: number | null; type: string; name: string; startsAt: string; endsAt: string }

/** Events: theme-colour cards, add/edit, Go live toggle (SPEC-LITE §8). */
@Component({
  selector: 'app-events-tab',
  imports: [FormsModule],
  template: `
    <div class="flex items-center justify-between">
      <h2 class="text-xl font-semibold">Events</h2>
      <button class="rounded-xl bg-primary px-4 py-2 font-semibold text-on-primary" (click)="startNew()">Add event</button>
    </div>

    @if (draft(); as d) {
      <form class="grid gap-3 rounded-2xl bg-surface p-4 shadow-sm md:grid-cols-5" (ngSubmit)="save(d)">
        <label class="flex flex-col gap-1 text-sm md:col-span-2">Name
          <input name="name" required maxlength="80" [(ngModel)]="d.name" class="rounded-lg border border-text/20 bg-bg px-3 py-2" /></label>
        <label class="flex flex-col gap-1 text-sm">Theme
          <select name="type" [(ngModel)]="d.type" class="rounded-lg border border-text/20 bg-bg px-3 py-2">
            @for (t of types; track t) { <option [value]="t">{{ t }}</option> }
          </select></label>
        <label class="flex flex-col gap-1 text-sm">Starts
          <input name="startsAt" type="datetime-local" required [(ngModel)]="d.startsAt" class="rounded-lg border border-text/20 bg-bg px-3 py-2" /></label>
        <label class="flex flex-col gap-1 text-sm">Ends
          <input name="endsAt" type="datetime-local" required [(ngModel)]="d.endsAt" class="rounded-lg border border-text/20 bg-bg px-3 py-2" /></label>
        <div class="flex gap-2 md:col-span-5">
          <button class="rounded-xl bg-primary px-4 py-2 font-semibold text-on-primary" [disabled]="busy()">
            {{ d.id ? 'Save changes' : 'Create event' }}</button>
          <button type="button" class="rounded-xl px-4 py-2 underline" (click)="draft.set(null)">Cancel</button>
        </div>
      </form>
    }

    <ul class="grid gap-4 md:grid-cols-2">
      @for (e of events(); track e.id) {
        <li class="overflow-hidden rounded-2xl bg-surface shadow-sm">
          <div class="h-3" [style.background]="theme(e.type).primary"></div>
          <div class="flex flex-col gap-3 p-4">
            <div class="flex items-start justify-between gap-3">
              <div>
                <h3 class="text-xl font-bold" [style.font-family]="theme(e.type).font">{{ e.name }}</h3>
                <p class="text-sm opacity-80">{{ when(e) }}</p>
              </div>
              <span class="rounded-full px-3 py-1 text-xs font-bold"
                    [class]="e.live ? 'bg-wait-green text-white' : e.ended ? 'bg-text/15' : 'bg-bg'">
                {{ e.live ? 'LIVE' : e.ended ? 'Ended' : 'Upcoming' }}</span>
            </div>
            <div class="flex gap-1.5" aria-hidden="true">
              @for (c of swatches(e.type); track $index) {
                <span class="h-6 w-6 rounded-full border border-text/15" [style.background]="c"></span>
              }
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <div class="inline-flex overflow-hidden rounded-xl border border-text/20" role="group" [attr.aria-label]="'Status of ' + e.name">
                @for (o of overrides; track o.value) {
                  <button class="px-3 py-1.5 text-sm font-semibold"
                          [class]="e.override === o.value ? 'bg-primary text-on-primary' : ''"
                          [attr.aria-pressed]="e.override === o.value" [disabled]="busy()" (click)="setOverride(e, o.value)">
                    {{ o.label }}</button>
                }
              </div>
              <button class="ml-auto text-sm underline" (click)="edit(e)">Edit</button>
            </div>
          </div>
        </li>
      }
    </ul>
  `,
  host: { class: 'flex flex-col gap-4' },
})
export class EventsTab implements OnInit {
  private readonly api = inject(Api);
  private readonly toast = inject(Toast);

  protected readonly events = signal<AdminEvent[]>([]);
  protected readonly draft = signal<Draft | null>(null);
  protected readonly busy = signal(false);
  protected readonly types = Object.keys(THEMES);
  protected readonly overrides = [
    { value: 'auto' as const, label: 'By schedule' },
    { value: 'live' as const, label: 'Go live now' },
    { value: 'ended' as const, label: 'End' },
  ];
  protected readonly theme = themeFor;

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.events.set((await this.api.get<{ events: AdminEvent[] }>('/api/admin/events')).events);
    } catch (e) {
      this.toast.error(errorText(e));
    }
  }

  protected swatches(type: string): string[] {
    const t = themeFor(type);
    return [t.primary, t.accent, t.bg];
  }
  protected when(e: AdminEvent): string {
    const f = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return `${f(e.startsAt)} – ${f(e.endsAt)}`;
  }

  protected startNew(): void {
    const start = Math.ceil(Date.now() / HOUR) * HOUR;
    this.draft.set({ id: null, type: 'sangeet', name: '', startsAt: toLocal(start), endsAt: toLocal(start + 3 * HOUR) });
  }
  protected edit(e: AdminEvent): void {
    this.draft.set({ id: e.id, type: e.type, name: e.name, startsAt: toLocal(e.startsAt), endsAt: toLocal(e.endsAt) });
  }

  protected async save(d: Draft): Promise<void> {
    const body = { type: d.type, name: d.name.trim(), startsAt: fromLocal(d.startsAt), endsAt: fromLocal(d.endsAt) };
    await this.run(async () => {
      if (d.id) await this.api.patch(`/api/admin/events/${d.id}`, body);
      else await this.api.post('/api/admin/events', body);
      this.draft.set(null);
      this.toast.show(d.id ? 'Event saved' : 'Event created');
    });
  }

  protected async setOverride(e: AdminEvent, override: AdminEvent['override']): Promise<void> {
    if (override === 'ended' && !confirm(`End ${e.name}? Everyone still in its queues will be cancelled.`)) return;
    return this.run(async () => {
      await this.api.post(`/api/admin/events/${e.id}/live`, { override });
      if (override === 'ended') this.toast.show(`${e.name} ended; open tickets were cancelled`);
    });
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    try {
      await fn();
      await this.load();
    } catch (e) {
      this.toast.error(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }
}
