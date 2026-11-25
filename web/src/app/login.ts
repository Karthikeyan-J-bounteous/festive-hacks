import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Api, errorText } from './core/api';
import { Auth } from './core/auth';
import { PublicWedding } from './core/models';
import { ThemeService } from './core/theme.service';

/** Phone → OTP (always 123456 in the demo) → the user's home, or `?next=`. */
@Component({
  selector: 'app-login',
  imports: [FormsModule],
  template: `
    <main class="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <header class="text-center">
        <p class="text-sm uppercase tracking-widest opacity-80">Varisai</p>
        <h1 class="font-display mt-2 text-4xl text-primary">{{ wedding()?.coupleNames ?? 'Welcome' }}</h1>
        @if (wedding()?.liveEvent; as ev) {
          <p class="mt-1 opacity-80">{{ ev.name }} is on now</p>
        }
      </header>

      <form class="flex flex-col gap-4 rounded-2xl bg-surface p-5 shadow-sm" (ngSubmit)="submit()">
        @if (step() === 'phone') {
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium">Your phone number</span>
            <input
              name="phone" type="tel" inputmode="tel" autocomplete="tel" required
              class="rounded-xl border border-text/20 bg-bg px-4 py-3 text-lg"
              [(ngModel)]="phone" placeholder="98765 43210" />
          </label>
        } @else {
          <p class="text-sm">Code sent to <strong>{{ phone }}</strong>.
            <button type="button" class="underline" (click)="step.set('phone')">Change</button></p>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium">6-digit code</span>
            <input
              #otpInput name="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required
              class="rounded-xl border border-text/20 bg-bg px-4 py-3 text-center text-2xl tracking-[0.4em]"
              [(ngModel)]="otp" />
          </label>
          <p class="text-xs opacity-80">Demo: the code is always 123456.</p>
        }
        @if (error()) {
          <p class="text-sm font-medium text-primary" role="alert">{{ error() }}</p>
        }
        <button
          type="submit" [disabled]="busy()"
          class="rounded-xl bg-primary px-4 py-3 text-lg font-semibold text-on-primary disabled:opacity-60">
          {{ step() === 'phone' ? 'Send code' : 'Continue' }}
        </button>
      </form>
    </main>
  `,
})
export class Login {
  private readonly auth = inject(Auth);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly theme = inject(ThemeService);

  protected readonly wedding = signal<PublicWedding | null>(null);
  protected readonly step = signal<'phone' | 'otp'>('phone');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected phone = '';
  protected otp = '';

  constructor() {
    this.api.get<PublicWedding>('/api/wedding').then(
      (w) => {
        this.wedding.set(w);
        this.theme.apply(w.liveEvent?.type ?? null);
      },
      () => this.theme.apply(null),
    );
  }

  protected async submit(): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      const phone = this.phone.replace(/[\s-]/g, '');
      if (this.step() === 'phone') {
        await this.auth.requestOtp(phone);
        this.phone = phone;
        this.step.set('otp');
      } else {
        const me = await this.auth.verify(phone, this.otp.trim());
        const next = this.route.snapshot.queryParamMap.get('next');
        await this.router.navigateByUrl(next && next.startsWith('/') ? next : me.home);
      }
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }
}
