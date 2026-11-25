import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import QRCode from 'qrcode';
import { Api, errorText } from '../core/api';
import { PublicWedding } from '../core/models';
import { Socket } from '../core/socket';

interface VenueCode {
  code: string;
  token: string;
  expiresAt: number;
  nowServing: { boothId: number; name: string; codes: string[] }[];
}

const RING = 2 * Math.PI * 54;

/** Fullscreen dark venue screen: rotating QR + 4-digit code + 30-s ring + Now serving (SPEC-LITE §8). */
@Component({
  selector: 'app-venue-screen',
  host: {
    class: 'fixed inset-0 overflow-auto bg-[#0E0A14] text-white ' +
      'bg-[radial-gradient(60rem_40rem_at_15%_10%,rgb(255_209_102/0.14),transparent_60%),radial-gradient(50rem_40rem_at_95%_90%,rgb(255_62_165/0.12),transparent_60%)]',
  },
  template: `
    <div class="h-3 bg-[radial-gradient(circle_at_50%_0,#FFD166_5px,transparent_5.5px)] bg-[length:22px_12px] bg-repeat-x opacity-80" aria-hidden="true"></div>
    <div class="mx-auto flex min-h-[calc(100%-0.75rem)] max-w-6xl flex-col gap-10 p-8 lg:flex-row lg:items-center">
      <section class="flex flex-1 flex-col items-center gap-6 text-center" aria-labelledby="venue-title">
        <p class="text-lg uppercase tracking-[0.35em] text-[#FFD166]">{{ wedding()?.coupleNames ?? 'Varisai' }}</p>
        <h1 id="venue-title" class="text-5xl font-bold tracking-tight">Scan to join the queues</h1>
        @if (qr()) {
          <div class="rounded-[2rem] bg-[linear-gradient(135deg,#FFD166,#FF3EA5)] p-1.5 shadow-[0_30px_80px_-20px_rgb(255_209_102/0.45)]">
            <img [src]="qr()" alt="Venue QR code: scan with your phone camera" class="h-72 w-72 rounded-[1.6rem] bg-white p-4 md:h-80 md:w-80" />
          </div>
        }
        <div class="flex items-center gap-6">
          <svg viewBox="0 0 120 120" class="h-28 w-28 -rotate-90" aria-hidden="true">
            <circle cx="60" cy="60" r="54" fill="none" stroke="rgba(255,255,255,.15)" stroke-width="10" />
            <circle cx="60" cy="60" r="54" fill="none" stroke="#FFD166" stroke-width="10" stroke-linecap="round"
                    [attr.stroke-dasharray]="ring" [attr.stroke-dashoffset]="ring * (1 - left() / 30)" />
          </svg>
          <div class="text-left">
            <p class="text-white/75">or type this code</p>
            <p class="font-mono text-7xl font-bold tracking-[0.2em]" aria-live="polite">{{ data()?.code ?? '····' }}</p>
            <p class="text-white/75">changes in {{ left() }} s</p>
          </div>
        </div>
        @if (error()) { <p class="text-red-300" role="alert">{{ error() }}</p> }
      </section>

      <section class="flex-1" aria-labelledby="serving-title">
        <h2 id="serving-title" class="mb-4 flex items-center gap-3 text-3xl font-bold">
          <span class="h-3 w-3 animate-pulse rounded-full bg-[#FFD166]" aria-hidden="true"></span>Now serving</h2>
        <ul class="grid gap-3 sm:grid-cols-2">
          @for (b of data()?.nowServing ?? []; track b.boothId) {
            <li class="rounded-2xl border border-white/10 bg-white/[0.06] p-5 backdrop-blur">
              <p class="text-sm font-semibold uppercase tracking-[0.18em] text-white/75">{{ b.name }}</p>
              <p class="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-3xl font-bold text-[#FFD166]">
                @for (c of b.codes; track c) { <span class="whitespace-nowrap">{{ c }}</span> } @empty { <span>—</span> }
              </p>
            </li>
          } @empty {
            <li class="text-white/75">No booth is open right now.</li>
          }
        </ul>
      </section>
    </div>
  `,
})
export class VenueScreen implements OnInit {
  private readonly api = inject(Api);
  private readonly socket = inject(Socket);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly data = signal<VenueCode | null>(null);
  protected readonly wedding = signal<PublicWedding | null>(null);
  protected readonly qr = signal('');
  protected readonly error = signal('');
  protected readonly now = signal(Date.now());
  protected readonly ring = RING;
  protected readonly left = computed(() => {
    const exp = this.data()?.expiresAt;
    return exp ? Math.max(0, Math.min(30, Math.ceil((exp - this.now()) / 1000))) : 30;
  });

  ngOnInit(): void {
    document.body.style.setProperty('--bg', '#0E0A14');
    void this.api.get<PublicWedding>('/api/wedding').then((w) => this.wedding.set(w), () => {});
    const tick = setInterval(() => {
      this.now.set(Date.now());
      const d = this.data();
      if (d && Date.now() > d.expiresAt + 500) void this.load(); // socket missed a rotation
    }, 500);
    const poll = setInterval(() => void this.load(), 5_000); // keeps "Now serving" fresh
    const offs = [
      this.socket.on('code:rotate', (c) => {
        this.data.update((d) => (d ? { ...d, ...c } : d));
        void this.renderQr(c.token);
      }),
      this.socket.on('booth:update', () => void this.load()),
    ];
    this.destroyRef.onDestroy(() => {
      clearInterval(tick);
      clearInterval(poll);
      offs.forEach((off) => off());
    });
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const d = await this.api.get<VenueCode>('/api/admin/venue-code');
      const changed = d.token !== this.data()?.token;
      this.data.set(d);
      this.error.set('');
      if (changed) await this.renderQr(d.token);
    } catch (e) {
      this.error.set(errorText(e));
    }
  }

  /** The QR opens the guest app with the token, which verifies presence in one step. */
  private async renderQr(token: string): Promise<void> {
    const url = `${location.origin}/w?code=${encodeURIComponent(token)}`;
    this.qr.set(await QRCode.toDataURL(url, { width: 640, margin: 1, errorCorrectionLevel: 'M' }));
  }
}
