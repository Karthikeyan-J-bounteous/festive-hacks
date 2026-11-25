import { Component, OnInit, input, output } from '@angular/core';
import confetti from 'canvas-confetti';
import { Ticket } from '../core/models';
import { reducedMotion } from '../shared/motion';

/** Full-screen "your turn" (SPEC-LITE §3): big code, vibrate, confetti. */
@Component({
  selector: 'app-takeover',
  host: {
    class: 'themed fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 overflow-hidden bg-primary bg-[radial-gradient(circle_at_50%_40%,rgb(255_255_255/0.22),transparent_60%)] px-6 text-center text-on-primary',
    role: 'alertdialog',
    'aria-modal': 'true',
    'aria-labelledby': 'takeover-title',
  },
  template: `
    <p class="text-sm font-bold uppercase tracking-[0.3em] opacity-85">Varisai</p>
    <p id="takeover-title" class="text-3xl font-bold">It's your turn!</p>
    <div class="relative my-4 grid place-items-center">
      <span class="halo absolute h-72 w-72 rounded-full bg-on-primary" aria-hidden="true"></span>
      <p class="relative rounded-[2rem] border-4 border-on-primary/40 bg-on-primary/10 px-8 py-6 font-display text-8xl leading-none tracking-wide"
         aria-label="Your token">{{ ticket().code }}</p>
    </div>
    <p class="text-xl">Please go to <strong>{{ ticket().boothName }}</strong></p>
    @if (ticket().roundId) {
      <p class="opacity-90">Your feast round is being seated now · party of {{ ticket().partySize }}</p>
    } @else {
      <p class="opacity-90">{{ ticket().option }} · show this code at the counter</p>
    }
    <button
      class="btn btn-lg mt-6 rounded-full bg-on-primary px-10 text-primary shadow-xl"
      (click)="dismiss.emit()" autofocus>
      On my way →
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
