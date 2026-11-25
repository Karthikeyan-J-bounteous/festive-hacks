import { Injectable, signal } from '@angular/core';

/** One message at a time, bottom of the screen, auto-hides. */
@Injectable({ providedIn: 'root' })
export class Toast {
  readonly message = signal<{ text: string; kind: 'info' | 'error' } | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;

  show(text: string, kind: 'info' | 'error' = 'info'): void {
    this.message.set({ text, kind });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.message.set(null), 4000);
  }
  error(text: string): void {
    this.show(text, 'error');
  }
}
