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
    <div class="fade-in fixed inset-0 z-30 bg-black/45 backdrop-blur-[2px]" (click)="close.emit()" aria-hidden="true"></div>
    <section
      class="sheet-up themed fixed inset-x-0 bottom-0 z-30 mx-auto max-w-lg rounded-t-[2rem] bg-surface px-5 pb-[max(2rem,env(safe-area-inset-bottom))] pt-3 shadow-2xl"
      role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div class="mx-auto mb-3 h-1.5 w-12 rounded-full bg-line" aria-hidden="true"></div>
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 id="sheet-title" class="font-display text-3xl leading-tight text-primary">{{ booth().name }}</h2>
          <p class="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
            <span class="wait-pill" [class]="dot()">{{ colourText() }}</span>
            <span class="opacity-85">
              @if (booth().paused) { taking a short break }
              @else if (booth().mode === 'batch') { next round in about {{ booth().waitMin }} min }
              @else { about {{ booth().waitMin }} min · {{ booth().waiting }} waiting }
            </span>
          </p>
        </div>
        <button class="btn btn-soft h-10 w-10 shrink-0 rounded-full p-0 text-xl leading-none" (click)="close.emit()" aria-label="Close">×</button>
      </div>

      @if (mine(); as t) {
        <div class="mt-5 flex items-center gap-4 rounded-2xl bg-tint p-4">
          <span class="font-display shrink-0 whitespace-nowrap text-4xl text-primary">{{ t.code }}</span>
          <p class="text-sm">You're already in this queue. Your ticket is at the top of the screen.</p>
        </div>
      } @else {
        @if (booth().options.length > 1) {
          <fieldset class="mt-6">
            <legend class="label mb-2">Choose</legend>
            <div class="flex flex-wrap gap-2">
              @for (o of booth().options; track o.label) {
                <button type="button" class="chip" [attr.aria-pressed]="o.label === option()" (click)="option.set(o.label)">
                  {{ o.label }} <span class="font-normal opacity-80">· {{ o.minutes }} min</span>
                </button>
              }
            </div>
          </fieldset>
        }

        @if (isGroup()) {
          <div class="mt-6 flex items-center justify-between rounded-2xl bg-tint px-4 py-3">
            <span class="label" id="party-label">People in your group</span>
            <div class="flex items-center gap-3" role="group" aria-labelledby="party-label">
              <button class="btn h-11 w-11 rounded-full border-2 border-line bg-surface p-0 text-xl" (click)="step(-1)"
                      [disabled]="party() <= 1" aria-label="One fewer">−</button>
              <span class="w-8 text-center text-2xl font-bold tabular-nums" aria-live="polite">{{ party() }}</span>
              <button class="btn h-11 w-11 rounded-full border-2 border-line bg-surface p-0 text-xl" (click)="step(1)"
                      [disabled]="party() >= maxParty" aria-label="One more">+</button>
            </div>
          </div>
        }

        @if (blocker(); as why) {
          <p class="mt-5 rounded-xl border border-primary/30 px-3 py-2 text-sm font-medium text-primary">{{ why }}</p>
        }
        @if (!feastOff()) {
          <button class="btn btn-primary btn-lg mt-5 w-full"
                  [disabled]="!!blocker() || busy()" (click)="join.emit({ option: option(), partySize: party() })">
            {{ busy() ? 'Joining…' : 'Join the queue' }}
          </button>
        }
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
  /** Flagsmith `feast_rounds` off: no joining feast (batch) booths. */
  readonly feastRounds = input(true);

  readonly join = output<{ option: string; partySize: number }>();
  readonly close = output<void>();

  protected readonly maxParty = MAX_PARTY;
  protected readonly option = signal('');
  protected readonly party = signal(1);
  protected readonly isGroup = computed(() => GROUP_SERVICES.has(this.booth().serviceType));
  protected readonly colourText = computed(() => COLOUR_TEXT[this.booth().colour]);
  protected readonly dot = computed(() => WAIT_DOT[this.booth().colour]);
  protected readonly feastOff = computed(() => this.booth().mode === 'batch' && !this.feastRounds());
  protected readonly blocker = computed(() => {
    if (this.feastOff()) return 'Feast rounds are paused right now. Please check back soon.';
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
