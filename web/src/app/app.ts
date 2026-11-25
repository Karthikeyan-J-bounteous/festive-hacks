import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  imports: [RouterOutlet],
  selector: 'app-root',
  templateUrl: './app.html',
})
export class App {
  protected readonly status = signal<'checking' | 'up' | 'down'>('checking');

  constructor() {
    fetch('/api/health')
      .then((r) => this.status.set(r.ok ? 'up' : 'down'))
      .catch(() => this.status.set('down'));
  }
}
