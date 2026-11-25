import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import QRCode from 'qrcode';
import { Api, errorText } from '../core/api';
import { Side } from '../core/models';
import { Toast } from '../core/toast';

interface QuotaRow {
  eventId: number;
  name: string;
  type: string;
  bride: { max: number; used: number };
  groom: { max: number; used: number };
}
interface PassView {
  id: number;
  side: Side;
  label: string;
  url: string;
  eventIds: number[];
  claimedBy: { userId: number; name: string | null; phone: string } | null;
  revokedAt: number | null;
}
interface Card { pass: PassView; link: string; qr: string }

const SIDES: Side[] = ['bride', 'groom'];
const sideName = (s: Side) => (s === 'bride' ? "Bride's side" : "Groom's side");

/** Quota grid, generate form → QR card (Share / Download PNG), passes table with Revoke (SPEC-LITE §8). */
@Component({
  selector: 'app-passes-tab',
  imports: [FormsModule],
  host: { class: 'flex flex-col gap-6' },
  template: `
    <section class="card p-4" aria-labelledby="quota-title">
      <h2 id="quota-title" class="mb-3 font-bold">Quotas <span class="text-sm font-normal opacity-75">· used / max per event</span></h2>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead><tr class="border-b border-line">
            <th scope="col" class="eyebrow py-2.5">Event</th>
            @for (s of sides; track s) { <th scope="col" class="eyebrow py-2.5">{{ sideName(s) }}</th> }
          </tr></thead>
          <tbody>
            @for (q of quotas(); track q.eventId) {
              <tr class="border-b border-line">
                <th scope="row" class="py-2 font-medium">{{ q.name }}</th>
                @for (s of sides; track s) {
                  <td class="py-2">
                    <span class="tabular-nums">{{ q[s].used }} /</span>
                    <input type="number" min="0" class="ml-1 w-20 input input-sm"
                           [attr.aria-label]="q.name + ' ' + sideName(s) + ' maximum'"
                           [value]="q[s].max" (change)="setQuota(q, s, $any($event.target).value)" />
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>
    </section>

    <div class="grid gap-6 lg:grid-cols-2">
      <section class="card p-4" aria-labelledby="gen-title">
        <h2 id="gen-title" class="mb-3 font-bold">Generate a family pass</h2>
        <form class="flex flex-col gap-3 text-sm" (ngSubmit)="generate()">
          <label class="flex flex-col gap-1">Who is it for?
            <input name="label" required maxlength="120" placeholder="e.g. Lakshmi Aunty (Chennai)" [(ngModel)]="label"
                   class="input" /></label>
          <div class="flex gap-4" role="radiogroup" aria-label="Side">
            @for (s of sides; track s) {
              <label><input type="radio" name="side" [value]="s" [(ngModel)]="side" /> {{ sideName(s) }}</label>
            }
          </div>
          <fieldset>
            <legend class="mb-1">Valid for</legend>
            <div class="flex flex-wrap gap-3">
              @for (q of quotas(); track q.eventId) {
                <label class="flex items-center gap-1">
                  <input type="checkbox" [checked]="picked().has(q.eventId)" (change)="toggle(q.eventId)" />
                  {{ q.name }} <span class="opacity-70">({{ q[side].max - q[side].used }} left)</span>
                </label>
              }
            </div>
          </fieldset>
          <button class="btn btn-primary self-start"
                  [disabled]="busy() || !label.trim() || picked().size === 0">Generate pass</button>
        </form>
      </section>

      @if (card(); as c) {
        <section class="flex flex-col items-center gap-3 rounded-[1.75rem] border-4 border-gold bg-surface p-6 text-center shadow-[var(--shadow-lg)]"
                 aria-labelledby="card-title">
          <span class="gold-badge px-4 py-1 tracking-widest">★ FAMILY PASS</span>
          <h2 id="card-title" class="font-display text-2xl">{{ c.pass.label }}</h2>
          <p class="text-sm">{{ sideName(c.pass.side) }} · {{ eventNames(c.pass.eventIds) }}</p>
          <img [src]="c.qr" alt="QR code for this family pass" class="h-56 w-56" />
          <p class="break-all text-xs opacity-75">{{ c.link }}</p>
          <div class="flex gap-2">
            <button class="btn btn-primary" (click)="share(c)">Share</button>
            <button class="btn btn-outline" (click)="download(c)">Download PNG</button>
          </div>
        </section>
      }
    </div>

    <section class="card p-4" aria-labelledby="list-title">
      <h2 id="list-title" class="mb-3 font-bold">Passes ({{ passes().length }})</h2>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead><tr class="border-b border-line">
            <th scope="col" class="eyebrow py-2.5">For</th><th scope="col" class="eyebrow">Side</th><th scope="col" class="eyebrow">Events</th>
            <th scope="col" class="eyebrow">Status</th><th scope="col" class="eyebrow"><span class="sr-only">Actions</span></th>
          </tr></thead>
          <tbody>
            @for (p of passes(); track p.id) {
              <tr class="border-b border-line" [class.opacity-60]="p.revokedAt">
                <td class="py-2 font-medium">{{ p.label }}</td>
                <td>{{ p.side }}</td>
                <td>{{ eventNames(p.eventIds) }}</td>
                <td>
                  @if (p.revokedAt) { Revoked }
                  @else if (p.claimedBy) { Claimed by {{ p.claimedBy.name ?? p.claimedBy.phone }} }
                  @else { Not claimed yet }
                </td>
                <td class="py-2 text-right">
                  @if (!p.revokedAt) {
                    <button class="btn btn-soft btn-sm mr-2" (click)="show(p)">QR</button>
                    <button class="btn btn-outline btn-sm" [disabled]="busy()" (click)="revoke(p)">Revoke</button>
                  }
                </td>
              </tr>
            } @empty {
              <tr><td colspan="5" class="py-3 opacity-75">No passes yet.</td></tr>
            }
          </tbody>
        </table>
      </div>
    </section>
  `,
})
export class PassesTab implements OnInit {
  private readonly api = inject(Api);
  private readonly toast = inject(Toast);

  protected readonly sides = SIDES;
  protected readonly sideName = sideName;
  protected readonly quotas = signal<QuotaRow[]>([]);
  protected readonly passes = signal<PassView[]>([]);
  protected readonly picked = signal<Set<number>>(new Set());
  protected readonly card = signal<Card | null>(null);
  protected readonly busy = signal(false);
  protected label = '';
  protected side: Side = 'bride';

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const [q, p] = await Promise.all([
        this.api.get<{ quotas: QuotaRow[] }>('/api/admin/quotas'),
        this.api.get<{ passes: PassView[] }>('/api/admin/passes'),
      ]);
      this.quotas.set(q.quotas);
      this.passes.set(p.passes);
    } catch (e) {
      this.toast.error(errorText(e));
    }
  }

  protected eventNames(ids: number[]): string {
    return this.quotas().filter((q) => ids.includes(q.eventId)).map((q) => q.name).join(', ');
  }

  protected toggle(id: number): void {
    this.picked.update((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  protected setQuota(q: QuotaRow, side: Side, value: string): Promise<void> {
    return this.run(async () => {
      const r = await this.api.put<{ quotas: QuotaRow[] }>('/api/admin/quotas', {
        quotas: [{ eventId: q.eventId, side, max: Math.max(0, Math.floor(Number(value) || 0)) }],
      });
      this.quotas.set(r.quotas);
    });
  }

  protected generate(): Promise<void> {
    return this.run(async () => {
      const { pass } = await this.api.post<{ pass: PassView }>('/api/admin/passes', {
        side: this.side, label: this.label.trim(), eventIds: [...this.picked()],
      });
      this.label = '';
      this.picked.set(new Set());
      await this.show(pass);
      await this.load();
    });
  }

  protected async show(p: PassView): Promise<void> {
    const link = `${location.origin}${p.url}`;
    this.card.set({ pass: p, link, qr: await QRCode.toDataURL(link, { width: 480, margin: 1 }) });
  }

  protected async revoke(p: PassView): Promise<void> {
    if (!confirm(`Revoke the pass for ${p.label}? Their priority ends now.`)) return;
    await this.run(async () => {
      await this.api.post(`/api/admin/passes/${p.id}/revoke`);
      if (this.card()?.pass.id === p.id) this.card.set(null);
      await this.load();
      this.toast.show('Pass revoked; quota freed');
    });
  }

  protected async share(c: Card): Promise<void> {
    const text = `${c.pass.label}, here is your family pass for the wedding. Open it on your phone:`;
    try {
      const file = new File([await (await fetch(await this.cardPng(c))).blob()], 'family-pass.png', { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: 'Family pass', text, url: c.link, files: [file] });
      } else if (navigator.share) {
        await navigator.share({ title: 'Family pass', text, url: c.link });
      } else {
        await navigator.clipboard.writeText(`${text} ${c.link}`);
        this.toast.show('Link copied');
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') this.toast.error(errorText(e));
    }
  }

  protected async download(c: Card): Promise<void> {
    const a = document.createElement('a');
    a.href = await this.cardPng(c);
    a.download = `family-pass-${c.pass.label.replace(/[^\w]+/g, '-').toLowerCase()}.png`;
    a.click();
  }

  /** QR card as a PNG: gold border, label, side, events, QR. */
  private async cardPng(c: Card): Promise<string> {
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 820;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#FFFDF7';
    g.fillRect(0, 0, 600, 820);
    g.strokeStyle = '#8b6508';
    g.lineWidth = 16;
    g.strokeRect(8, 8, 584, 804);
    g.textAlign = 'center';
    g.fillStyle = '#8b6508';
    g.font = 'bold 26px Inter, sans-serif';
    g.fillText('★ FAMILY PASS', 300, 80);
    g.fillStyle = '#241A1C';
    g.font = 'bold 36px Cinzel, serif';
    g.fillText(c.pass.label.slice(0, 32), 300, 140);
    g.font = '22px Inter, sans-serif';
    g.fillText(`${sideName(c.pass.side)} · ${this.eventNames(c.pass.eventIds)}`.slice(0, 48), 300, 180);
    const img = new Image();
    img.src = c.qr;
    await img.decode();
    g.drawImage(img, 80, 220, 440, 440);
    g.font = '20px Inter, sans-serif';
    g.fillText('Scan with your phone camera', 300, 710);
    g.fillText('Priority lane at every booth', 300, 745);
    return canvas.toDataURL('image/png');
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    try {
      await fn();
    } catch (e) {
      this.toast.error(errorText(e));
      await this.load();
    } finally {
      this.busy.set(false);
    }
  }
}
