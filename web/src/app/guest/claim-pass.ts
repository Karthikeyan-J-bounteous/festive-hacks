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
        <section class="relative flex flex-col items-center gap-3 overflow-hidden rounded-[2rem] border-4 border-gold bg-surface p-7 shadow-[var(--shadow-lg)]"
                 aria-labelledby="pass-title">
          <div class="festoon absolute inset-x-0 top-0" aria-hidden="true"></div>
          <span class="gold-badge mt-3 px-4 py-1 text-sm tracking-widest">★ FAMILY PASS</span>
          <h1 id="pass-title" class="font-display text-4xl leading-tight text-primary">{{ p.label }}</h1>
          <div class="ornament w-32" aria-hidden="true"><span></span></div>
          <p class="font-semibold">{{ p.side === 'bride' ? "Bride's side" : "Groom's side" }}</p>
          <p class="text-sm opacity-80">You get the priority lane at every booth for {{ p.eventIds.length }}
            {{ p.eventIds.length === 1 ? 'event' : 'events' }}. Your tickets show a gold badge.</p>
        </section>
        <a routerLink="/w" class="btn btn-primary btn-lg">Go to the venue map →</a>
      } @else {
        <span class="mx-auto grid h-20 w-20 place-items-center rounded-full bg-[linear-gradient(135deg,#a67c0d,#6f5006)] text-4xl text-white shadow-lg" aria-hidden="true">★</span>
        <h1 class="font-display text-4xl leading-tight text-primary">You've been sent a family pass</h1>
        <p class="opacity-80">Claim it once on this phone. It can't be moved to another number afterwards.</p>
        @if (error()) { <p class="font-medium text-primary" role="alert">{{ error() }}</p> }
        <button class="btn btn-primary btn-lg" [disabled]="busy()" (click)="claim()">{{ busy() ? 'Claiming…' : 'Claim my pass' }}</button>
        <a routerLink="/w" class="text-sm font-medium opacity-80 hover:underline">Not now</a>
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
