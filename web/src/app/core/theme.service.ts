import { Injectable, signal } from '@angular/core';
import { Theme, themeFor } from './themes';

/** Writes the theme's CSS variables on <body>; `body` transitions colours over 400 ms (styles.css). */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly current = signal<string | null>(null);

  apply(type: string | null): Theme {
    const t = themeFor(type);
    const s = document.body.style;
    s.setProperty('--primary', t.primary);
    s.setProperty('--accent', t.accent);
    s.setProperty('--bg', t.bg);
    s.setProperty('--surface', t.surface);
    s.setProperty('--text', t.text);
    s.setProperty('--on-primary', t.onPrimary);
    s.setProperty('--display-font', t.font);
    document.body.classList.toggle('theme-dark', t.dark);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.bg);
    this.current.set(type);
    return t;
  }
}
