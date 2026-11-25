import { Component, OnInit, input, output } from '@angular/core';
import confetti from 'canvas-confetti';
import { Splash as SplashKind } from '../core/themes';
import { reducedMotion } from '../shared/motion';

const FALLING: Record<SplashKind, string> = { leaves: '🍃', petals: '🌸', confetti: '' };

/** 1.5 s themed splash, tap to skip (SPEC-LITE §3). */
@Component({
  selector: 'app-splash',
  host: {
    class: 'themed fixed inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-bg px-6 text-center',
    role: 'button',
    tabindex: '0',
    'aria-label': 'Skip intro',
    '(click)': 'done.emit()',
    '(keydown.enter)': 'done.emit()',
    '(keydown.escape)': 'done.emit()',
  },
  template: `
    @if (!still) {
      @for (i of drops; track i) {
        <span class="splash-drop" aria-hidden="true"
              [style.left.%]="(i * 37) % 100" [style.animation-delay.ms]="(i * 130) % 900">{{ falling[kind()] }}</span>
      }
    }
    <p class="splash-in text-lg opacity-80">{{ couple() }}</p>
    <h1 class="splash-in font-display text-5xl text-primary" style="animation-delay: 350ms">{{ eventName() }}</h1>
    <p class="mt-8 text-xs opacity-70">Tap to continue</p>
  `,
})
export class Splash implements OnInit {
  readonly couple = input.required<string>();
  readonly eventName = input.required<string>();
  readonly kind = input<SplashKind>('petals');
  readonly done = output<void>();

  protected readonly falling = FALLING;
  protected readonly drops = Array.from({ length: 14 }, (_, i) => i);
  protected readonly still = reducedMotion();

  ngOnInit(): void {
    if (!this.still && this.kind() === 'confetti') {
      void confetti({ particleCount: 120, spread: 90, origin: { y: 0.3 }, colors: ['#FF3EA5', '#7C5CFF', '#FFD166'] });
    }
    setTimeout(() => this.done.emit(), this.still ? 900 : 1500);
  }
}
