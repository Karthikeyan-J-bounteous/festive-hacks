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
        class="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-md rounded-xl px-4 py-3 text-center shadow-lg"
        [class]="m.kind === 'error' ? 'bg-text text-bg' : 'bg-primary text-on-primary'"
        role="status" aria-live="polite">
        {{ m.text }}
      </div>
    }
  `,
})
export class App {
  protected readonly toast = inject(Toast);
}
