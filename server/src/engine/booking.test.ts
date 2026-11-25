import { describe, expect, it } from 'vitest';
import { EventTiming, JoinContext, checkJoin, isLive } from './booking';
import { MINUTE } from './types';

describe('isLive', () => {
  const e = (o: EventTiming['status_override']): EventTiming => ({ starts_at: 100 * MINUTE, ends_at: 200 * MINUTE, status_override: o });
  it.each([
    ['live override, any time', e('live'), 0, true],
    ['ended override, mid-event', e('ended'), 150 * MINUTE, false],
    ['auto, 31 min before start', e('auto'), 69 * MINUTE, false],
    ['auto, 30 min before start', e('auto'), 70 * MINUTE, true],
    ['auto, last minute', e('auto'), 200 * MINUTE - 1, true],
    ['auto, at the end', e('auto'), 200 * MINUTE, false],
  ])('%s → %s', (_n, ev, now, live) => {
    expect(isLive(ev, now)).toBe(live);
  });
});

describe('checkJoin', () => {
  const ok: JoinContext = {
    eventLive: true, boothPaused: false, presenceValid: true, hasActiveAtBooth: false,
    activeInEvent: 0, serviceType: 'mehendi', partySize: 1, optionValid: true,
  };

  it('allows a normal join', () => expect(checkJoin(ok)).toBeNull());

  it.each<[string, Partial<JoinContext>, string | null]>([
    ['event not live', { eventLive: false }, 'event_not_live'],
    ['booth paused', { boothPaused: true }, 'booth_paused'],
    ['no presence', { presenceValid: false }, 'presence_required'],
    ['already in this queue', { hasActiveAtBooth: true }, 'duplicate'],
    ['3rd ticket in the event is fine', { activeInEvent: 2 }, null],
    ['4th ticket in the event', { activeInEvent: 3 }, 'max_tickets'],
    ['unknown option', { optionValid: false }, 'bad_option'],
    ['group at a solo booth', { partySize: 2 }, 'bad_party_size'],
    ['blessing group of 12', { serviceType: 'blessing', partySize: 12 }, null],
    ['feast party of 13', { serviceType: 'feast', partySize: 13 }, 'bad_party_size'],
    ['party of 0', { serviceType: 'feast', partySize: 0 }, 'bad_party_size'],
  ])('%s', (_n, over, expected) => {
    expect(checkJoin({ ...ok, ...over })).toBe(expected);
  });
});
