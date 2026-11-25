import { Component, computed, effect, input, output, signal } from '@angular/core';
import { Booth, Ticket } from '../core/models';

const GROUP_SERVICES = new Set(['blessing', 'feast']);
const MAX_PARTY = 12;
const COLOUR_TEXT = { green: 'Short wait', amber: 'Moderate wait', red: 'Long wait', grey: 'Paused' } as const;
// Literal class names so Tailwind generates them.
const WAIT_DOT = { green: 'bg-wait-green', amber: 'bg-wait-amber', red: 'bg-wait-red', grey: 'bg-wait-grey' } as const;

/** Tap a pin → wait, options, party stepper, Join (SPEC-LITE §8). */
@Component({
  selector: 'app-booth-sheet',
  template: `
    <div class="fixed inset-0 z-30 bg-black/40" (click)="close.emit()" aria-hidden="true"></div>
    <section
      class="sheet-up themed fixed inset-x-0 bottom-0 z-30 mx-auto max-w-lg rounded-t-3xl bg-surface p-5 pb-8 shadow-2xl"
      role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h2 id="sheet-title" class="font-display text-2xl text-primary">{{ booth().name }}</h2>
          <p class="mt-1 text-sm">
            <span class="inline-block h-2.5 w-2.5 rounded-full align-middle" [class]="dot()"></span>
            {{ colourText() }} ·
            @if (booth().paused) { taking a short break }
            @else if (booth().mode === 'batch') { next round in about {{ booth().waitMin }} min }
            @else { about {{ booth().waitMin }} min · {{ booth().waiting }} waiting }
          </p>
        </div>
        <button class="rounded-full px-3 py-1 text-2xl leading-none" (click)="close.emit()" aria-label="Close">×</button>
      </div>

      @if (mine(); as t) {
        <p class="mt-5 rounded-xl bg-bg p-4">You're in this queue as <strong>{{ t.code }}</strong>.</p>
      } @else {
        @if (booth().options.length > 1) {
          <fieldset class="mt-5">
            <legend class="mb-2 text-sm font-medium">Choose</legend>
            <div class="flex flex-wrap gap-2">
              @for (o of booth().options; track o.label) {
                <button
                  type="button" class="rounded-full border-2 px-4 py-2 text-sm font-medium"
                  [class]="o.label === option() ? 'border-primary bg-primary text-on-primary' : 'border-text/20'"
                  [attr.aria-pressed]="o.label === option()" (click)="option.set(o.label)">
                  {{ o.label }} · {{ o.minutes }} min
                </button>
              }
            </div>
          </fieldset>
        }

        @if (isGroup()) {
          <div class="mt-5 flex items-center justify-between">
            <span class="text-sm font-medium" id="party-label">People in your group</span>
            <div class="flex items-center gap-3" role="group" aria-labelledby="party-label">
              <button class="h-11 w-11 rounded-full border-2 border-text/20 text-xl" (click)="step(-1)"
                      [disabled]="party() <= 1" aria-label="One fewer">−</button>
              <span class="w-8 text-center text-xl font-bold" aria-live="polite">{{ party() }}</span>
              <button class="h-11 w-11 rounded-full border-2 border-text/20 text-xl" (click)="step(1)"
                      [disabled]="party() >= maxParty" aria-label="One more">+</button>
            </div>
          </div>
        }

        @if (blocker(); as why) {
          <p class="mt-5 text-sm font-medium text-primary">{{ why }}</p>
        }
        <button
          class="mt-5 w-full rounded-xl bg-primary px-4 py-4 text-lg font-bold text-on-primary disabled:opacity-50"
          [disabled]="!!blocker() || busy()" (click)="join.emit({ option: option(), partySize: party() })">
          {{ busy() ? 'Joining…' : 'Join the queue' }}
        </button>
      }
    </section>
  `,
})
export class BoothSheet {
  readonly booth = input.required<Booth>();
  readonly mine = input<Ticket | null>(null);
  readonly presenceValid = input(false);
  readonly ticketsInEvent = input(0);
  readonly busy = input(false);

  readonly join = output<{ option: string; partySize: number }>();
  readonly close = output<void>();

  protected readonly maxParty = MAX_PARTY;
  protected readonly option = signal('');
  protected readonly party = signal(1);
  protected readonly isGroup = computed(() => GROUP_SERVICES.has(this.booth().serviceType));
  protected readonly colourText = computed(() => COLOUR_TEXT[this.booth().colour]);
  protected readonly dot = computed(() => WAIT_DOT[this.booth().colour]);
  protected readonly blocker = computed(() => {
    if (this.booth().paused) return 'This booth is paused for a moment.';
    if (!this.presenceValid()) return 'Verify you are at the venue first (top of the screen).';
    if (this.ticketsInEvent() >= 3) return 'You can hold at most 3 queues per event.';
    return '';
  });

  constructor() {
    effect(() => {
      const b = this.booth();
      if (!b.options.some((o) => o.label === this.option())) this.option.set(b.options[0]?.label ?? '');
    });
  }

  protected step(d: number): void {
    this.party.update((p) => Math.min(MAX_PARTY, Math.max(1, p + d)));
  }
}
