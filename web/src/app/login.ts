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
    <div class="festoon fixed inset-x-0 top-0 z-10" aria-hidden="true"></div>
    <main class="themed mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-8 px-5 py-12">
      <header class="flex flex-col items-center gap-3 text-center">
        <span class="eyebrow">Varisai · வரிசை</span>
        <h1 class="font-display text-5xl leading-tight text-primary">{{ wedding()?.coupleNames ?? 'Welcome' }}</h1>
        <div class="ornament w-40" aria-hidden="true"><span></span></div>
        @if (wedding()?.liveEvent; as ev) {
          <p class="inline-flex items-center gap-2 rounded-full bg-surface px-3 py-1 text-sm font-medium shadow-sm">
            <span class="h-2 w-2 animate-pulse rounded-full bg-wait-green" aria-hidden="true"></span>
            {{ ev.name }} is on now
          </p>
        } @else {
          <p class="text-sm opacity-75">Skip the line at every booth.</p>
        }
      </header>

      <form class="card flex flex-col gap-4 p-6" (ngSubmit)="submit()">
        @if (step() === 'phone') {
          <label class="flex flex-col gap-1.5">
            <span class="label">Your phone number</span>
            <input
              name="phone" type="tel" inputmode="tel" autocomplete="tel" required
              class="input text-lg"
              [(ngModel)]="phone" placeholder="98765 43210" />
          </label>
        } @else {
          <p class="text-sm">Code sent to <strong>{{ phone }}</strong>
            <button type="button" class="ml-1 font-semibold text-primary underline-offset-2 hover:underline" (click)="step.set('phone')">Change</button></p>
          <label class="flex flex-col gap-1.5">
            <span class="label">6-digit code</span>
            <input
              #otpInput name="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required
              class="input text-center font-mono text-2xl tracking-[0.5em]"
              [(ngModel)]="otp" />
          </label>
          <p class="rounded-lg bg-tint px-3 py-2 text-xs">Demo: the code is always <strong>123456</strong>.</p>
        }
        @if (error()) {
          <p class="text-sm font-medium text-primary" role="alert">{{ error() }}</p>
        }
        <button type="submit" [disabled]="busy()" class="btn btn-primary btn-lg">
          {{ busy() ? 'Please wait…' : step() === 'phone' ? 'Send code' : 'Continue' }}
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
