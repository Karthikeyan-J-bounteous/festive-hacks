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
    <div class="festoon" aria-hidden="true"></div>
    <div class="mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 px-4 pb-10 pt-5 md:px-6">
      <header class="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p class="eyebrow">Varisai · Organiser</p>
          <h1 class="font-display text-4xl leading-tight text-primary">Dashboard</h1>
        </div>
        <a routerLink="/admin/venue" target="_blank" class="btn btn-primary">Open venue screen ↗</a>
      </header>
      <nav class="flex w-fit max-w-full gap-1 overflow-x-auto rounded-2xl border border-line bg-surface p-1 shadow-sm"
           aria-label="Dashboard sections">
        @for (t of tabs; track t.path) {
          <a [routerLink]="t.path" routerLinkActive="bg-primary text-on-primary shadow-sm" ariaCurrentWhenActive="page"
             class="shrink-0 rounded-xl px-5 py-2 text-sm font-semibold transition-colors hover:bg-tint">{{ t.label }}</a>
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
