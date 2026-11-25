import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ThemeService } from '../core/theme.service';

const TABS = [
  { path: 'overview', label: 'Overview' },
  { path: 'events', label: 'Events' },
  { path: 'layout', label: 'Layout' },
  { path: 'passes', label: 'Passes' },
];

/** Admin dashboard (desktop) with tabs (SPEC-LITE §8). */
@Component({
  selector: 'app-admin-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <div class="mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 px-4 py-6">
      <header class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p class="text-xs uppercase tracking-widest opacity-75">Varisai · Organiser</p>
          <h1 class="font-display text-3xl text-primary">Dashboard</h1>
        </div>
        <a routerLink="/admin/venue" target="_blank"
           class="rounded-xl bg-primary px-4 py-2 font-semibold text-on-primary">Open venue screen ↗</a>
      </header>
      <nav class="flex gap-1 overflow-x-auto border-b border-text/15" aria-label="Dashboard sections">
        @for (t of tabs; track t.path) {
          <a [routerLink]="t.path" routerLinkActive="border-primary text-primary" ariaCurrentWhenActive="page"
             class="-mb-px border-b-4 border-transparent px-4 py-2 font-semibold">{{ t.label }}</a>
        }
      </nav>
      <router-outlet />
    </div>
  `,
})
export class AdminShell {
  protected readonly tabs = TABS;

  constructor() {
    inject(ThemeService).apply(null);
  }
}
