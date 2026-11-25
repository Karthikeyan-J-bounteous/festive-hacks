export const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** sessionStorage that never throws (private mode, blocked storage). */
export const session = {
  get(key: string): string | null {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
};

/** "10–15 min", or "now" when the range is 0. */
/** eta_style "people" arm of the A/B test (§14.2). */
export function aheadText(ahead: number): string {
  if (ahead === 0) return "you're next";
  return ahead === 1 ? '1 person ahead' : `${ahead} people ahead`;
}

export function etaText(eta: { low: number; high: number } | null): string {
  if (!eta) return '';
  if (eta.high === 0) return 'any moment';
  return eta.low === eta.high ? `~${eta.low} min` : `${eta.low}–${eta.high} min`;
}
