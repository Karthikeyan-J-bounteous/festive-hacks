// Queue simulation (SPEC-LITE §11 S7): physical lines vs Varisai virtual queues.
// `npm run simulate -w server` (optional: SEED=7). Prints a markdown table for the README.
//
// The same 400 guests (seeded RNG) arrive over 2 h and want the same booths in both runs.
//  - Physical: a guest stands in one line at a time, visiting their booths in turn.
//  - Varisai:  a guest joins every queue on arrival and keeps mingling. When the ticker's `almostDue`
//              picks them (next artists + 1 free guests) they get the "almost" nudge and walk over; standing runs from that nudge (or the call) to
//              service. Calls use the real engine: `callNext` and `orderWaiting` (VIP ratio, busy-elsewhere
//              deferral) and feast `buildRound` (first-fit, families kept whole).
// Conservative for Varisai: its walks count as standing; walks between physical lines don't.
import { buildRound } from '../src/engine/batch';
import { almostDue, callNext } from '../src/engine/live';
import { Booth, MINUTE, Ticket } from '../src/engine/types';

type Mode = 'physical' | 'virtual';

const SEED = Number(process.env.SEED ?? 2026);
const GUESTS = 400;
const WINDOW_MIN = 120;
const STEP_MIN = 0.25;
const MAX_MIN = 12 * 60;

/** mulberry32: small, fast, deterministic. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Option { minutes: number; weight: number }
interface BoothSpec {
  id: number;
  name: string;
  mode: 'live' | 'batch';
  artists: number;           // live: servers; batch: unused
  seats?: number;
  roundMinutes?: number;
  demand: number;            // share of guests who want it
  options: Option[];
}

// A busy Mehendi evening with dinner. Staffing keeps each booth near (not far past) capacity,
// so lines form at the peak and drain soon after the 2 h window.
const BOOTHS: BoothSpec[] = [
  { id: 1, name: 'Mehendi table', mode: 'live', artists: 10, demand: 0.12,
    options: [{ minutes: 15, weight: 0.6 }, { minutes: 30, weight: 0.3 }, { minutes: 45, weight: 0.1 }] },
  { id: 2, name: 'Nail art', mode: 'live', artists: 4, demand: 0.06,
    options: [{ minutes: 15, weight: 0.7 }, { minutes: 25, weight: 0.3 }] },
  { id: 3, name: 'Chaat counter', mode: 'live', artists: 5, demand: 0.6,
    options: [{ minutes: 2, weight: 0.6 }, { minutes: 3, weight: 0.4 }] },
  { id: 4, name: 'Dining hall', mode: 'batch', artists: 1, seats: 160, roundMinutes: 25, demand: 0.7,
    options: [{ minutes: 25, weight: 1 }] },
];
const PARTY_SIZES: Option[] = [ // reused shape: minutes = party size
  { minutes: 1, weight: 0.4 }, { minutes: 2, weight: 0.3 }, { minutes: 3, weight: 0.1 }, { minutes: 4, weight: 0.1 },
  { minutes: 5, weight: 0.05 }, { minutes: 6, weight: 0.05 },
];

function pick(rand: () => number, opts: readonly Option[]): number {
  let r = rand();
  for (const o of opts) {
    if ((r -= o.weight) < 0) return o.minutes;
  }
  return opts[opts.length - 1].minutes;
}

interface Visit {
  boothId: number;
  baseMinutes: number;
  serviceMinutes: number;    // actual: base × 0.75–1.35
  party: number;
  walkMinutes: number;       // 1–3 min
}
interface Guest { id: number; arriveMin: number; visits: Visit[] }

function makeGuests(rand: () => number): Guest[] {
  const guests: Guest[] = [];
  for (let id = 1; id <= GUESTS; id++) {
    const arriveMin = ((rand() + rand()) / 2) * WINDOW_MIN; // triangular: peak mid-window
    const visits: Visit[] = [];
    for (const b of BOOTHS) {
      if (rand() >= b.demand) continue;
      const base = pick(rand, b.options);
      visits.push({
        boothId: b.id,
        baseMinutes: base,
        serviceMinutes: b.mode === 'batch' ? base : base * (0.75 + rand() * 0.6),
        party: b.mode === 'batch' ? pick(rand, PARTY_SIZES) : 1,
        walkMinutes: 1 + rand() * 2,
      });
    }
    for (let i = visits.length - 1; i > 0; i--) { // physical visiting order
      const j = Math.floor(rand() * (i + 1));
      [visits[i], visits[j]] = [visits[j], visits[i]];
    }
    if (visits.length === 0) { // everyone wants something: a plate of chaat
      visits.push({ boothId: 3, baseMinutes: 2, serviceMinutes: 2 * (0.75 + rand() * 0.6), party: 1, walkMinutes: 1 + rand() * 2 });
    }
    guests.push({ id, arriveMin, visits });
  }
  return guests;
}

interface VisitResult { waitMin: number; standingMin: number; endMin: number }
interface Meta { guest: Guest; visit: Visit; endAt: number | null; nudgedAt: number | null }

function simulate(mode: Mode, guests: readonly Guest[]) {
  const booths = new Map<number, Booth>(BOOTHS.map((s) => [s.id, {
    id: s.id, mode: s.mode, service_type: s.name, artists: s.artists, paused: 0, speed_factor: 1,
    regulars_since_vip: 0, round_seats: s.seats ?? null, round_minutes: s.roundMinutes ?? null,
  }]));
  const active = new Map<number, Ticket[]>(BOOTHS.map((s) => [s.id, []]));
  const meta = new Map<number, Meta>();
  const roundEnds = new Map<number, number | null>();
  const results = new Map<number, VisitResult[]>(guests.map((g) => [g.id, []]));
  const pendingJoins: { at: number; guest: Guest; index: number }[] = [];
  const walkingTo = new Map<number, number>(); // virtual: user → ticket they were nudged toward
  let nextId = 1;
  let seq = 1;
  let remaining = guests.reduce((n, g) => n + g.visits.length, 0);

  const join = (guest: Guest, visit: Visit, now: number) => {
    const t: Ticket = {
      id: nextId++, booth_id: visit.boothId, user_id: guest.id, status: 'waiting', seq: seq++, is_vip: 0,
      skip_count: 0, base_minutes: visit.baseMinutes, party_size: visit.party, joined_at: now,
      called_at: null, serving_at: null, done_at: null, away_since: null, round_id: null,
    };
    active.get(visit.boothId)!.push(t);
    meta.set(t.id, { guest, visit, endAt: null, nudgedAt: null });
  };

  const busyUsers = (): Set<number> => {
    const s = new Set<number>();
    for (const list of active.values()) for (const t of list) if (t.status === 'called' || t.status === 'serving') s.add(t.user_id);
    return s;
  };

  const finish = (t: Ticket, now: number) => {
    const m = meta.get(t.id)!;
    t.status = 'done';
    t.done_at = now;
    const list = active.get(t.booth_id)!;
    list.splice(list.indexOf(t), 1);
    remaining--;
    const waitMin = (t.serving_at! - t.joined_at) / MINUTE;
    results.get(m.guest.id)!.push({
      waitMin,
      standingMin: mode === 'physical' ? waitMin : (t.serving_at! - (m.nudgedAt ?? t.called_at!)) / MINUTE,
      endMin: now / MINUTE,
    });
    if (mode === 'physical') {
      const index = m.guest.visits.indexOf(m.visit) + 1;
      if (index < m.guest.visits.length) {
        pendingJoins.push({ at: now + m.guest.visits[index].walkMinutes * MINUTE, guest: m.guest, index });
      }
    }
  };

  /** A guest is called somewhere: any nudge toward a different booth is dropped (they re-queue for it). */
  const callTo = (t: Ticket) => {
    const nudged = walkingTo.get(t.user_id);
    if (nudged !== undefined && nudged !== t.id) {
      for (const list of active.values()) {
        const other = list.find((x) => x.id === nudged);
        if (other) meta.get(other.id)!.nudgedAt = null;
      }
    }
    walkingTo.delete(t.user_id);
  };

  const arrivals = [...guests].sort((a, b) => a.arriveMin - b.arriveMin);
  let ai = 0;

  for (let tMin = 0; remaining > 0 && tMin <= MAX_MIN; tMin += STEP_MIN) {
    const now = Math.round(tMin * MINUTE);

    // 1. Arrivals and physical walks to the next line.
    while (ai < arrivals.length && arrivals[ai].arriveMin * MINUTE <= now) {
      const g = arrivals[ai++];
      if (mode === 'physical') join(g, g.visits[0], now);
      else for (const v of g.visits) join(g, v, now);
    }
    for (let i = pendingJoins.length - 1; i >= 0; i--) {
      const p = pendingJoins[i];
      if (p.at > now) continue;
      join(p.guest, p.guest.visits[p.index], now);
      pendingJoins.splice(i, 1);
    }

    // 2. Services that ended; 3. called guests who reached the booth start.
    for (const list of active.values()) {
      for (const t of [...list]) {
        const m = meta.get(t.id)!;
        if (t.status === 'serving' && m.endAt !== null && m.endAt <= now) finish(t, now);
      }
    }
    for (const list of active.values()) {
      for (const t of list) {
        if (t.status !== 'called') continue;
        const m = meta.get(t.id)!;
        // Physical: already at the front. Varisai: walking since the nudge, or since the call.
        const arrives = mode === 'physical' ? t.called_at! : (m.nudgedAt ?? t.called_at!) + m.visit.walkMinutes * MINUTE;
        if (Math.max(t.called_at!, arrives) > now) continue;
        t.status = 'serving';
        t.serving_at = now;
        const booth = booths.get(t.booth_id)!;
        m.endAt = booth.mode === 'batch' ? roundEnds.get(booth.id)! : now + m.visit.serviceMinutes * MINUTE;
      }
    }

    // 4. Live booths: call while an artist is free (the real engine picks who).
    for (const booth of booths.values()) {
      if (booth.mode !== 'live') continue;
      const list = active.get(booth.id)!;
      for (;;) {
        const busy = busyUsers();
        const r = callNext(booth, list, busy, now);
        if (!r) break;
        const t = list.find((x) => x.id === r.ticketId)!;
        if (busy.has(t.user_id)) break; // everyone waiting is busy elsewhere: the artist waits
        t.status = 'called';
        t.called_at = now;
        booth.regulars_since_vip = r.regularsSinceVip;
        callTo(t);
      }
    }

    // 4b. Varisai: the ticker's "almost" nudge. The top waiting guests who are free start walking over.
    if (mode === 'virtual') {
      const busy = busyUsers();
      for (const booth of booths.values()) {
        if (booth.mode !== 'live') continue;
        for (const t of almostDue(active.get(booth.id)!, booth, busy)) {
          if (walkingTo.has(t.user_id) || meta.get(t.id)!.nudgedAt !== null) continue;
          meta.get(t.id)!.nudgedAt = now;
          walkingTo.set(t.user_id, t.id);
        }
      }
    }

    // 5. Feast: when a round ends, seat the next one (guests busy elsewhere keep their place).
    for (const booth of booths.values()) {
      if (booth.mode !== 'batch') continue;
      const ends = roundEnds.get(booth.id) ?? null;
      if (ends !== null && now < ends) continue;
      const list = active.get(booth.id)!;
      const busy = busyUsers();
      const eligible = list.filter((t) => t.status === 'waiting' && !busy.has(t.user_id));
      if (eligible.length === 0) {
        roundEnds.set(booth.id, null);
        continue;
      }
      const endsAt = now + booth.round_minutes! * MINUTE;
      for (const t of buildRound(eligible, booth.round_seats!).round) {
        t.status = 'called';
        t.called_at = now;
        callTo(t);
      }
      roundEnds.set(booth.id, endsAt);
    }
  }

  if (remaining > 0) throw new Error(`${mode}: ${remaining} visits unfinished after ${MAX_MIN} min`);
  return metrics(guests, results);
}

function metrics(guests: readonly Guest[], results: Map<number, VisitResult[]>) {
  const waits = [...results.values()].flat().map((r) => r.waitMin).sort((a, b) => a - b);
  const standing = guests.map((g) => results.get(g.id)!.reduce((s, r) => s + r.standingMin, 0));
  const finishMin = guests.map((g) => Math.max(...results.get(g.id)!.map((r) => r.endMin)) - g.arriveMin);
  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  return {
    avgStanding: avg(standing),
    p90Wait: waits[Math.min(waits.length - 1, Math.floor(waits.length * 0.9))],
    guestHoursStanding: standing.reduce((s, x) => s + x, 0) / 60,
    avgFinish: avg(finishMin),
  };
}

function main(): void {
  const guests = makeGuests(makeRng(SEED));
  const visits = guests.reduce((n, g) => n + g.visits.length, 0);
  const phys = simulate('physical', guests);
  const virt = simulate('virtual', guests);
  const f = (n: number) => n.toFixed(1);
  const change = (a: number, b: number) => `${b <= a ? '−' : '+'}${Math.abs(Math.round((1 - b / a) * 100))}%`;
  const rows: [string, number, number][] = [
    ['Avg standing per guest (min)', phys.avgStanding, virt.avgStanding],
    ['p90 wait per booth visit (min)', phys.p90Wait, virt.p90Wait],
    ['Total guest-hours standing', phys.guestHoursStanding, virt.guestHoursStanding],
    ['Avg time to finish all booths (min)', phys.avgFinish, virt.avgFinish],
  ];
  console.log(`Seed ${SEED} · ${guests.length} guests over ${WINDOW_MIN / 60} h · ${visits} booth visits · `
    + BOOTHS.map((b) => b.mode === 'live' ? `${b.name} ×${b.artists}` : `${b.name} ${b.seats} seats/${b.roundMinutes} min`).join(', '));
  console.log('');
  console.log('| Metric | Physical lines | Varisai | Change |');
  console.log('|---|---:|---:|---:|');
  for (const [label, a, b] of rows) console.log(`| ${label} | ${f(a)} | ${f(b)} | ${change(a, b)} |`);
}

main();
