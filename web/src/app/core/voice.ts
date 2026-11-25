import { Injectable, signal } from '@angular/core';

/** Languages offered for Sarvam voice alerts (SPEC-LITE §14.1), in their own script. */
export const VOICE_LANGS = [
  { code: 'en-IN', label: 'English' },
  { code: 'ta-IN', label: 'தமிழ்' },
  { code: 'hi-IN', label: 'हिन्दी' },
  { code: 'kn-IN', label: 'ಕನ್ನಡ' },
  { code: 'te-IN', label: 'తెలుగు' },
  { code: 'ml-IN', label: 'മലയാളം' },
] as const;

const PREF_KEY = 'varisai.voice';
// A tiny silent WAV, played inside a tap so the browser allows audio later (autoplay rules).
const SILENT =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

/**
 * Plays Sarvam "your turn" audio. Browsers only allow sound after a user gesture, so the guest
 * taps "Enable voice alerts" once; after that we remember the choice and re-unlock on the first
 * tap of any later visit. One shared <audio> element keeps iOS happy.
 */
@Injectable({ providedIn: 'root' })
export class Voice {
  private readonly audio = typeof Audio === 'function' ? new Audio() : null;
  /** Guest opted in (remembered across visits). */
  readonly wanted = signal(readPref());
  /** Audio is unlocked for this page load. */
  readonly unlocked = signal(false);

  constructor() {
    if (this.wanted()) {
      const once = () => {
        void this.unlock();
        document.removeEventListener('pointerdown', once, true);
      };
      document.addEventListener('pointerdown', once, true);
    }
  }

  /** Call from a click handler. */
  async unlock(): Promise<void> {
    writePref();
    this.wanted.set(true);
    if (!this.audio || this.unlocked()) return;
    try {
      this.audio.src = SILENT;
      await this.audio.play();
      this.unlocked.set(true);
    } catch {
      /* still blocked; the takeover's replay button is a fresh gesture */
    }
  }

  /** Play base64 MP3. Resolves false if the browser blocked it. */
  async play(base64: string): Promise<boolean> {
    if (!this.audio) return false;
    try {
      this.audio.src = `data:audio/mpeg;base64,${base64}`;
      await this.audio.play();
      this.unlocked.set(true);
      return true;
    } catch {
      return false;
    }
  }
}

function readPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === '1';
  } catch {
    return false;
  }
}
function writePref(): void {
  try {
    localStorage.setItem(PREF_KEY, '1');
  } catch {
    /* ignore */
  }
}
