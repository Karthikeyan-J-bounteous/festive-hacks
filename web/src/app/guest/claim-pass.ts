import { Component, OnInit, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, errorText } from '../core/api';
import { MyPass } from '../core/models';
import { ThemeService } from '../core/theme.service';

interface ClaimResult { pass: MyPass | null }

/** `/p/:token`: claim a family pass, then show it (SPEC-LITE §8 family-pass screen). */
@Component({
  selector: 'app-claim-pass',
  imports: [RouterLink],
  template: `
    <main class="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-4 py-10 text-center">
      @if (pass(); as p) {
        <section class="flex flex-col items-center gap-3 rounded-3xl border-4 border-gold bg-surface p-6 shadow" aria-labelledby="pass-title">
          <p class="text-sm font-bold uppercase tracking-widest text-gold">★ Family pass</p>
          <h1 id="pass-title" class="font-display text-3xl text-primary">{{ p.label }}</h1>
          <p>{{ p.side === 'bride' ? "Bride's side" : "Groom's side" }}</p>
          <p class="text-sm opacity-80">You get the priority lane at every booth for {{ p.eventIds.length }}
            {{ p.eventIds.length === 1 ? 'event' : 'events' }}. Your tickets show a gold badge.</p>
        </section>
        <a routerLink="/w" class="rounded-xl bg-primary px-4 py-3 text-lg font-bold text-on-primary">Go to the venue map</a>
      } @else {
        <h1 class="font-display text-3xl text-primary">You've been sent a family pass</h1>
        <p class="opacity-80">Claim it once on this phone. It can't be moved to another number afterwards.</p>
        @if (error()) { <p class="font-medium text-primary" role="alert">{{ error() }}</p> }
        <button class="rounded-xl bg-primary px-4 py-3 text-lg font-bold text-on-primary disabled:opacity-60"
                [disabled]="busy()" (click)="claim()">{{ busy() ? 'Claiming…' : 'Claim my pass' }}</button>
        <a routerLink="/w" class="underline">Not now</a>
      }
    </main>
  `,
})
export class ClaimPass implements OnInit {
  private readonly api = inject(Api);
  readonly token = input.required<string>();

  protected readonly pass = signal<MyPass | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  constructor() {
    inject(ThemeService).apply('muhurtham');
  }

  ngOnInit(): void {
    // Already claimed by me? Show it straight away.
    void this.api.get<{ pass: MyPass | null }>('/api/guest/bootstrap').then((b) => b.pass && this.pass.set(b.pass), () => {});
  }

  protected async claim(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      const r = await this.api.post<ClaimResult>('/api/guest/passes/claim', { token: this.token() });
      this.pass.set(r.pass);
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }
}
