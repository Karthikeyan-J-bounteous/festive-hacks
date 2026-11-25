import { Component, input, output } from '@angular/core';
import { Ticket } from '../core/models';
import { aheadText, etaText } from '../shared/motion';

/** Code, position, ETA range, I'm away / Cancel, gold family badge (SPEC-LITE §8). */
@Component({
  selector: 'app-ticket-card',
  host: { class: 'block drop-shadow-[0_8px_14px_rgb(0_0_0/0.14)]' },
  template: `
    <article
      class="stub themed relative flex h-full flex-col overflow-hidden rounded-2xl bg-surface"
      [attr.aria-label]="'Ticket ' + ticket().code + ' at ' + ticket().boothName">
      <!-- Top: booth + code, tinted -->
      <div class="flex h-21 items-start justify-between gap-2 px-4 pt-3"
           [class]="ticket().isVip ? 'bg-[linear-gradient(135deg,#fbf3dc,#f3e2b0)] text-[#2a1f05]' : 'bg-tint'">
        <div class="min-w-0">
          <p class="truncate text-[0.7rem] font-bold uppercase tracking-[0.16em] opacity-75">{{ ticket().boothName }}</p>
          <p class="font-display text-4xl leading-tight" [class.text-primary]="!ticket().isVip">{{ ticket().code }}</p>
        </div>
        @if (ticket().isVip) {
          <span class="gold-badge mt-0.5 shrink-0">★ Family</span>
        } @else if (ticket().status === 'called') {
          <span class="mt-1 h-3 w-3 shrink-0 animate-ping rounded-full bg-accent" aria-hidden="true"></span>
        }
      </div>
      <div class="mx-4 border-t-2 border-dashed border-line" aria-hidden="true"></div>

      <div class="flex flex-1 flex-col gap-2 px-4 pb-4 pt-3">
        <p class="text-sm" aria-live="polite">
          @switch (ticket().status) {
            @case ('waiting') {
              @if (ticket().eta; as eta) {
                @if (ticket().roundId === null && isBatch()) {
                  <strong class="text-base">Round {{ eta.position }}</strong> · {{ wait(eta) }}
                } @else {
                  <strong class="text-base">#{{ eta.position }}</strong> in line · {{ wait(eta) }}
                }
              } @else { In line }
            }
            @case ('away') { <strong>Away</strong> · place held for 20 min }
            @case ('called') { <strong class="text-base text-primary">Your turn, go now!</strong> }
            @case ('serving') { <strong>Being served</strong> }
          }
        </p>
        @if (note()) {
          <p class="rounded-lg bg-accent/12 px-2.5 py-1.5 text-xs font-semibold">{{ note() }}</p>
        }
        <p class="text-xs opacity-75">{{ ticket().option }}@if (ticket().partySize > 1) { · party of {{ ticket().partySize }} }</p>

        @if (ticket().status === 'waiting' || ticket().status === 'away') {
          <div class="mt-auto flex gap-2 pt-1">
            @if (ticket().status === 'waiting') {
              <button class="btn btn-soft btn-sm flex-1" [disabled]="busy()" (click)="act.emit('away')">I'm away</button>
            } @else {
              <button class="btn btn-primary btn-sm flex-1" [disabled]="busy()" (click)="act.emit('back')">I'm back</button>
            }
            <button class="btn btn-sm text-primary hover:underline" [disabled]="busy()" (click)="act.emit('cancel')">Cancel</button>
          </div>
        }
      </div>
    </article>
  `,
})
export class TicketCard {
  readonly ticket = input.required<Ticket>();
  readonly isBatch = input(false);
  readonly note = input('');
  readonly busy = input(false);
  /** Flagsmith A/B: "~15–20 min" vs "3 people ahead". */
  readonly etaStyle = input<'minutes' | 'people'>('minutes');
  readonly act = output<'away' | 'back' | 'cancel'>();

  protected wait(eta: { ahead: number; low: number; high: number }): string {
    return this.etaStyle() === 'people' ? aheadText(eta.ahead) : etaText(eta);
  }
}
