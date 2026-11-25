import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Toast } from './core/toast';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `
    <router-outlet />
    @if (toast.message(); as m) {
      <div
        class="toast-in fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[70] mx-auto flex max-w-md items-center gap-3 rounded-2xl px-4 py-3 font-medium shadow-[var(--shadow-lg)]"
        [class]="m.kind === 'error' ? 'bg-text text-bg' : 'bg-primary text-on-primary'"
        role="status" aria-live="polite">
        <span class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/20 text-sm" aria-hidden="true">{{ m.kind === 'error' ? '!' : '✓' }}</span>
        <span class="flex-1">{{ m.text }}</span>
      </div>
    }
  `,
})
export class App {
  protected readonly toast = inject(Toast);
}
