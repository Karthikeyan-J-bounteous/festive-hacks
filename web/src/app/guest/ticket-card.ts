import { Component, input, output } from '@angular/core';
import { Ticket } from '../core/models';
import { etaText } from '../shared/motion';

/** Code, position, ETA range, I'm away / Cancel, gold family badge (SPEC-LITE §8). */
@Component({
  selector: 'app-ticket-card',
  host: { class: 'block' },
  template: `
    <article
      class="themed flex h-full flex-col gap-2 rounded-2xl border-2 bg-surface p-4 shadow-sm"
      [class]="ticket().isVip ? 'border-gold' : 'border-transparent'"
      [attr.aria-label]="'Ticket ' + ticket().code + ' at ' + ticket().boothName">
      <div class="flex items-start justify-between gap-2">
        <div>
          <p class="text-xs font-medium uppercase tracking-wide opacity-75">{{ ticket().boothName }}</p>
          <p class="font-display text-3xl leading-tight text-primary">{{ ticket().code }}</p>
        </div>
        @if (ticket().isVip) {
          <span class="rounded-full bg-gold px-2 py-0.5 text-xs font-bold text-white">★ Family</span>
        }
      </div>

      <p class="text-sm" aria-live="polite">
        @switch (ticket().status) {
          @case ('waiting') {
            @if (ticket().eta; as eta) {
              @if (ticket().roundId === null && isBatch()) {
                <strong>Round {{ eta.position }}</strong> · {{ etaText(eta) }}
              } @else {
                <strong>#{{ eta.position }}</strong> in line · {{ etaText(eta) }}
              }
            } @else { In line }
          }
          @case ('away') { <strong>Away</strong> · your place is held for 20 min }
          @case ('called') { <strong class="text-primary">Your turn, go now!</strong> }
          @case ('serving') { <strong>Being served</strong> }
        }
      </p>
      @if (note()) {
        <p class="rounded-lg bg-bg px-2 py-1 text-xs font-medium">{{ note() }}</p>
      }
      <p class="text-xs opacity-75">{{ ticket().option }}@if (ticket().partySize > 1) { · party of {{ ticket().partySize }} }</p>

      @if (ticket().status === 'waiting' || ticket().status === 'away') {
        <div class="mt-auto flex gap-2 pt-1">
          @if (ticket().status === 'waiting') {
            <button class="flex-1 rounded-lg border-2 border-text/20 px-2 py-2 text-sm font-medium"
                    [disabled]="busy()" (click)="act.emit('away')">I'm away</button>
          } @else {
            <button class="flex-1 rounded-lg bg-primary px-2 py-2 text-sm font-bold text-on-primary"
                    [disabled]="busy()" (click)="act.emit('back')">I'm back</button>
          }
          <button class="rounded-lg px-3 py-2 text-sm font-medium text-primary underline"
                  [disabled]="busy()" (click)="act.emit('cancel')">Cancel</button>
        </div>
      }
    </article>
  `,
})
export class TicketCard {
  readonly ticket = input.required<Ticket>();
  readonly isBatch = input(false);
  readonly note = input('');
  readonly busy = input(false);
  readonly act = output<'away' | 'back' | 'cancel'>();

  protected readonly etaText = etaText;
}
