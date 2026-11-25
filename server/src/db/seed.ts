import { config } from '../env';
import { randomBytes } from 'node:crypto';
import { db, tx } from './db';

const MIN = 60_000;
const HOUR = 60 * MIN;

const TABLES_IN_DELETE_ORDER = [
  'tickets', 'rounds', 'presence', 'pass_events', 'family_passes', 'pass_quotas',
  'booth_handlers', 'booths', 'events', 'memberships', 'weddings', 'users',
];

function insert(sql: string, ...params: (string | number | null)[]): number {
  return Number(db.prepare(sql).run(...params).lastInsertRowid);
}

function resetAll(): void {
  for (const t of TABLES_IN_DELETE_ORDER) db.exec(`DELETE FROM ${t}`);
  db.exec(`DELETE FROM sqlite_sequence`);
}

export function rowCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of [...TABLES_IN_DELETE_ORDER].reverse()) {
    out[t] = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
  }
  return out;
}

export function seedIfEmpty(): boolean {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM weddings').get() as { n: number };
  if (n > 0) return false;
  seed();
  return true;
}

type BoothSpec = {
  name: string; service: string; prefix: string; mode: 'live' | 'batch';
  x: number; y: number; options: { label: string; minutes: number }[];
  artists?: number; seats?: number; roundMinutes?: number;
};

export function seed(): void {
  const now = Date.now();
  tx(() => {
    resetAll();

    const wedding = insert(
      `INSERT INTO weddings (name, couple_names, venue_lat, venue_lng, radius_m, qr_secret) VALUES (?,?,?,?,?,?)`,
      'Priya & Arjun Wedding', 'Priya ❤ Arjun', config.seedLat, config.seedLng, 150,
      randomBytes(24).toString('hex'),
    );

    // ---- events (Mehendi + Feast are forced live so the demo works at any hour) ----
    const ev = (type: string, name: string, startH: number, endH: number, override: string, order: number) =>
      insert(
        `INSERT INTO events (wedding_id, type, name, starts_at, ends_at, status_override, sort_order) VALUES (?,?,?,?,?,?,?)`,
        wedding, type, name, now + startH * HOUR, now + endH * HOUR, override, order,
      );
    const mehendi = ev('mehendi', 'Mehendi', -2, 6, 'live', 1);
    const sangeet = ev('sangeet', 'Sangeet', 24, 29, 'auto', 2);
    const muhurtham = ev('muhurtham', 'Muhurtham', 36, 39, 'auto', 3);
    const feast = ev('feast', 'Kalyana Virundhu', 37, 41, 'live', 4);
    const events = [mehendi, sangeet, muhurtham, feast];

    // ---- booths (x/y are % of the 1000x700 Kalyana Mandapam viewBox) ----
    const booth = (eventId: number, b: BoothSpec) =>
      insert(
        `INSERT INTO booths (event_id, name, service_type, code_prefix, mode, x_pct, y_pct, options_json,
                             artists, round_seats, round_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        eventId, b.name, b.service, b.prefix, b.mode, b.x, b.y, JSON.stringify(b.options),
        b.artists ?? 1, b.seats ?? null, b.roundMinutes ?? null,
      );
    const mehendiTable = booth(mehendi, {
      name: 'Mehendi table', service: 'mehendi', prefix: 'M', mode: 'live', x: 25, y: 35, artists: 2,
      options: [{ label: 'Palm only', minutes: 15 }, { label: 'Full hand', minutes: 30 }, { label: 'Both hands', minutes: 45 }],
    });
    const nailArt = booth(mehendi, {
      name: 'Nail art', service: 'nails', prefix: 'N', mode: 'live', x: 38, y: 20,
      options: [{ label: 'Classic', minutes: 15 }, { label: 'Gel art', minutes: 25 }],
    });
    const chaat = booth(mehendi, {
      name: 'Chaat counter', service: 'food', prefix: 'C', mode: 'live', x: 46, y: 46,
      options: [{ label: 'Pani puri', minutes: 5 }, { label: 'Full plate', minutes: 8 }],
    });
    const songDesk = booth(sangeet, {
      name: 'Song request desk', service: 'song', prefix: 'S', mode: 'live', x: 18, y: 22,
      options: [{ label: 'Request a song', minutes: 3 }],
    });
    const mocktail = booth(sangeet, {
      name: 'Mocktail bar', service: 'drinks', prefix: 'K', mode: 'live', x: 45, y: 32,
      options: [{ label: 'Mocktail', minutes: 4 }],
    });
    const blessing = booth(muhurtham, {
      name: 'Blessing queue', service: 'blessing', prefix: 'B', mode: 'live', x: 30, y: 12,
      options: [{ label: 'Blessing', minutes: 3 }],
    });
    const dining = booth(feast, {
      name: 'Dining hall', service: 'feast', prefix: 'F', mode: 'batch', x: 78, y: 28,
      seats: 40, roundMinutes: 25, options: [{ label: 'Feast seating', minutes: 25 }],
    });

    // ---- quotas: every event Bride 40 / Groom 25 ----
    for (const e of events) {
      insert(`INSERT INTO pass_quotas (event_id, side, max_passes) VALUES (?,?,?)`, e, 'bride', 40);
      insert(`INSERT INTO pass_quotas (event_id, side, max_passes) VALUES (?,?,?)`, e, 'groom', 25);
    }

    // ---- users (OTP is always 123456) ----
    const user = (phone: string, name: string) => insert(`INSERT INTO users (phone, name) VALUES (?,?)`, phone, name);
    const member = (u: number, role: string, side: string | null = null) =>
      insert(`INSERT INTO memberships (wedding_id, user_id, role, side) VALUES (?,?,?,?)`, wedding, u, role, side);

    const admin = user('9000000001', 'Wedding Planner');
    member(admin, 'admin');

    const handlerMehendi = user('9000000010', 'Meena (Mehendi artist)');
    const handlerFeast = user('9000000011', 'Ravi (Caterer lead)');
    const handlerSangeet = user('9000000012', 'Karthik (Stage coordinator)');
    for (const h of [handlerMehendi, handlerFeast, handlerSangeet]) {
      member(h, 'booth_handler');
      member(h, 'guest');
    }
    for (const b of [mehendiTable, nailArt, chaat]) insert(`INSERT INTO booth_handlers VALUES (?,?)`, b, handlerMehendi);
    insert(`INSERT INTO booth_handlers VALUES (?,?)`, dining, handlerFeast);
    for (const b of [songDesk, mocktail, blessing]) insert(`INSERT INTO booth_handlers VALUES (?,?)`, b, handlerSangeet);

    const guestNames = ['Lakshmi Chithi', 'Ananya', 'Suresh Mama', 'Divya', 'Rahul', 'Kavya', 'Vikram', 'Nisha', 'Arun', 'Pooja'];
    const guests: number[] = [];
    for (let i = 0; i < 10; i++) {
      const phone = String(9000000100 + i);
      const u = user(phone, guestNames[i]);
      guests.push(u);
      member(u, 'guest', i < 2 ? 'bride' : i === 2 ? 'groom' : null);
      insert(`INSERT INTO presence (user_id, wedding_id, valid_until) VALUES (?,?,?)`, u, wedding, now + 12 * HOUR);
    }
    const g = (phoneSuffix: number) => guests[phoneSuffix - 100];

    // ---- three claimed family passes (100, 101 bride side; 102 groom side) ----
    const pass = (side: 'bride' | 'groom', label: string, claimer: number) => {
      const id = insert(
        `INSERT INTO family_passes (wedding_id, side, token, label, claimed_by_user_id) VALUES (?,?,?,?,?)`,
        wedding, side, randomBytes(16).toString('base64url'), label, claimer,
      );
      for (const e of events) insert(`INSERT INTO pass_events VALUES (?,?)`, id, e);
    };
    pass('bride', "Lakshmi Chithi (Bride's mother's sister)", g(100));
    pass('bride', "Ananya (Bride's cousin)", g(101));
    pass('groom', "Suresh Mama (Groom's uncle)", g(102));
    const vip = new Set([g(100), g(101), g(102)]);

    // ---- live tickets so every screen looks alive ----
    const seqByBooth = new Map<number, number>();
    const ticket = (
      boothId: number, eventId: number, prefix: string, phone: number, option: string, minutes: number,
      status: 'waiting' | 'called' | 'serving', opts: { party?: number; ageMin?: number; roundId?: number } = {},
    ) => {
      const seq = (seqByBooth.get(boothId) ?? 0) + 1;
      seqByBooth.set(boothId, seq);
      const joined = now - (opts.ageMin ?? 5) * MIN;
      const calledAt = status === 'waiting' ? null : now - 3 * MIN;
      const servingAt = status === 'serving' ? now - 2 * MIN : null;
      return insert(
        `INSERT INTO tickets (booth_id, event_id, user_id, code, option_label, base_minutes, party_size, is_vip,
                              status, seq, round_id, joined_at, called_at, serving_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        boothId, eventId, g(phone), `${prefix}-${String(seq).padStart(3, '0')}`, option, minutes,
        opts.party ?? 1, vip.has(g(phone)) ? 1 : 0, status, seq, opts.roundId ?? null, joined, calledAt, servingAt,
      );
    };

    // Mehendi table (2 artists): two being served, four waiting
    ticket(mehendiTable, mehendi, 'M', 107, 'Full hand', 30, 'serving', { ageMin: 40 });
    ticket(mehendiTable, mehendi, 'M', 108, 'Palm only', 15, 'serving', { ageMin: 30 });
    ticket(mehendiTable, mehendi, 'M', 103, 'Both hands', 45, 'waiting', { ageMin: 25 });
    ticket(mehendiTable, mehendi, 'M', 100, 'Full hand', 30, 'waiting', { ageMin: 20 });
    ticket(mehendiTable, mehendi, 'M', 104, 'Palm only', 15, 'waiting', { ageMin: 15 });
    ticket(mehendiTable, mehendi, 'M', 105, 'Full hand', 30, 'waiting', { ageMin: 10 });
    // Nail art
    ticket(nailArt, mehendi, 'N', 105, 'Gel art', 25, 'waiting', { ageMin: 12 });
    ticket(nailArt, mehendi, 'N', 109, 'Classic', 15, 'waiting', { ageMin: 8 });
    // Chaat (107 is being served at the Mehendi table: shows conflict deferral)
    ticket(chaat, mehendi, 'C', 104, 'Pani puri', 5, 'waiting', { ageMin: 9 });
    ticket(chaat, mehendi, 'C', 101, 'Full plate', 8, 'waiting', { ageMin: 7 });
    ticket(chaat, mehendi, 'C', 109, 'Pani puri', 5, 'waiting', { ageMin: 6 });
    ticket(chaat, mehendi, 'C', 107, 'Full plate', 8, 'waiting', { ageMin: 4 });

    // Feast: rounds 1-3 done, round 4 seating (22 of 40 seats used), five parties waiting
    for (let r = 1; r <= 3; r++) {
      insert(`INSERT INTO rounds (booth_id, round_no, status, started_at, ends_at) VALUES (?,?,?,?,?)`,
        dining, r, 'done', now - (4 - r) * 25 * MIN - 5 * MIN, now - (3 - r) * 25 * MIN - 5 * MIN);
    }
    const round4 = insert(
      `INSERT INTO rounds (booth_id, round_no, status, started_at, ends_at) VALUES (?,?,?,?,?)`,
      dining, 4, 'seating', now - 5 * MIN, now + 20 * MIN);
    const feastParty: [number, number, 'called' | 'waiting'][] = [
      [100, 4, 'called'], [101, 3, 'called'], [102, 5, 'called'], [103, 6, 'called'], [104, 4, 'called'],
      [105, 4, 'waiting'], [106, 6, 'waiting'], [107, 3, 'waiting'], [108, 5, 'waiting'], [109, 2, 'waiting'],
    ];
    for (const [phone, party, status] of feastParty) {
      ticket(dining, feast, 'F', phone, 'Feast seating', 25, status, {
        party, ageMin: 30, roundId: status === 'called' ? round4 : undefined,
      });
    }
  });
}

if (require.main === module) {
  const reset = process.argv.includes('--reset');
  if (reset) {
    seed();
    console.log('Database reset and re-seeded.');
  } else if (seedIfEmpty()) {
    console.log('Database seeded.');
  } else {
    console.log('Database already has data (use `npm run seed -- --reset` to wipe and re-seed).');
  }
  console.table(rowCounts());
}
