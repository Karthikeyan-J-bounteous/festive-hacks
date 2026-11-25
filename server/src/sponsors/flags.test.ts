// Flagsmith (SPEC-LITE §14.2): keyless defaults path and SDK → flag resolution.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FLAGS, FlagSource, etaStyleOf, flag, flagsFor, flagsmithEnabled, refreshFlags, resolveFlags, setFlagsForTest,
  startFlags,
} from './flags';

const source = (enabled: Record<string, boolean>, values: Record<string, unknown> = {}): FlagSource => ({
  isFeatureEnabled: (n) => enabled[n] ?? false,
  getFeatureValue: (n) => values[n] ?? null,
});

describe('flags', () => {
  afterEach(() => setFlagsForTest());

  it('without a key: all on, eta_style "minutes", no network, no polling', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(flagsmithEnabled()).toBe(false);
    expect(await flagsFor(7)).toEqual(DEFAULT_FLAGS);
    expect(flag('family_passes') && flag('feast_rounds') && flag('voice_alerts') && flag('presence_geofence')).toBe(true);
    expect(etaStyleOf(7)).toBe('minutes');
    expect(await refreshFlags([7])).toBeNull();
    const onChange = vi.fn();
    startFlags(() => [7], onChange);
    expect(onChange).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('maps SDK flags: booleans by enabled, eta_style "people" only when enabled with that value', () => {
    const all = { family_passes: true, feast_rounds: true, voice_alerts: true, presence_geofence: true, eta_style: true };
    expect(resolveFlags(source(all, { eta_style: 'people' }))).toEqual({ ...DEFAULT_FLAGS, eta_style: 'people' });
    expect(resolveFlags(source({ ...all, feast_rounds: false, voice_alerts: false }, { eta_style: 'minutes' })))
      .toEqual({ ...DEFAULT_FLAGS, feast_rounds: false, voice_alerts: false });
    expect(resolveFlags(source({ ...all, eta_style: false }, { eta_style: 'people' })).eta_style).toBe('minutes');
    expect(resolveFlags(source(all, { eta_style: 'bogus' })).eta_style).toBe('minutes');
  });
});
