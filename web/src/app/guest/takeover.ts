import { Component, OnInit, input, output } from '@angular/core';
import confetti from 'canvas-confetti';
import { Ticket } from '../core/models';
import { reducedMotion } from '../shared/motion';

/** Full-screen "your turn" (SPEC-LITE §3): big code, vibrate, confetti. */
@Component({
  selector: 'app-takeover',
  host: {
    class: 'themed fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-primary px-6 text-center text-on-primary',
    role: 'alertdialog',
    'aria-modal': 'true',
    'aria-labelledby': 'takeover-title',
  },
  template: `
    <p id="takeover-title" class="text-2xl font-semibold">It's your turn!</p>
    <p class="font-display text-8xl leading-none tracking-wide" aria-label="Your token">{{ ticket().code }}</p>
    <p class="text-xl">Please go to <strong>{{ ticket().boothName }}</strong></p>
    @if (ticket().roundId) {
      <p class="opacity-90">Your feast round is being seated now · party of {{ ticket().partySize }}</p>
    } @else {
      <p class="opacity-90">{{ ticket().option }} · show this code at the counter</p>
    }
    <button
      class="mt-6 rounded-full bg-on-primary px-8 py-4 text-lg font-bold text-primary"
      (click)="dismiss.emit()" autofocus>
      On my way
    </button>
  `,
})
export class Takeover implements OnInit {
  readonly ticket = input.required<Ticket>();
  readonly dismiss = output<void>();

  ngOnInit(): void {
    navigator.vibrate?.([300, 100, 300]);
    if (!reducedMotion()) {
      const fire = (x: number) => void confetti({ particleCount: 90, spread: 70, origin: { x, y: 0.7 }, zIndex: 60 });
      fire(0.2);
      setTimeout(() => fire(0.8), 250);
    }
  }
}
