# Varisai — Implementation Plan (v3, full scope)

> **Use `SPEC-LITE.md` for the actual 6–8 h / Claude Pro build.** This file is the full-scope reference. Where the two disagree, SPEC-LITE wins. The product was formerly named ShaadiQ.

> **One QR for every queue at an Indian wedding.**
> Guests scan a QR at the venue, the app themes itself to the event that's live (Haldi turns turmeric-yellow, Sangeet goes neon), shows the hall map with live wait times, and lets them hold places in up to 3 queues at once. Bride & groom families get limited, single-use **Family Passes** for priority. Booth handlers run each counter from their phone. The organiser runs everything from a dashboard.

Hackathon constraints: **6–8 hours**, public repo, README anyone can set up from, working demo, 2-min video. Build in the order of §15. Anything in §16 *Non-goals* must not be built.

---

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Monorepo | npm workspaces: `/server`, `/web` | One `npm install` |
| Server | Node 20+, TypeScript, Express, built-in `node:sqlite` (`DatabaseSync`), `socket.io`, `zod`, `jsonwebtoken`, Jest + supertest | Zero external services, sync transactions, no native add-ons (Windows Smart App Control blocks unsigned `.node` files such as `better-sqlite3`) |
| Web | Latest Angular (standalone, signals), Tailwind CSS (colors from CSS variables), Angular CDK drag-drop, `chart.js`, `qrcode`, `html5-qrcode` (in-app scanner), `canvas-confetti` | Themable, fast to build |
| Realtime | Socket.io rooms | |
| Tests | Jest (engine + API), one Playwright smoke test | |
| Run | `npm install && npm run dev` → seeds DB if empty, runs both apps (`concurrently`) | |
| Deploy | Express serves Angular build; single service on Render/Railway | |

**.env.example**
```
PORT=3000
JWT_SECRET=change-me
OTP_MODE=demo               # demo → OTP is always 123456 ; twilio → real SMS
TWILIO_ACCOUNT_SID=         # optional; WhatsApp alerts disabled if empty
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_FROM=
ANTHROPIC_API_KEY=          # optional; "import from invitation" hidden if empty
SEED_LAT=13.0827            # set to hackathon venue
SEED_LNG=80.2707
```

**Folder structure**
```
/server/src
  engine/            # PURE logic, no I/O, no Date.now() — pass `now`
    live.ts  slot.ts  batch.ts  eta.ts  passes.ts  presence.ts  rbac.ts
    *.test.ts
  db/  schema.sql  db.ts  seed.ts  templates.ts  events-catalog.ts
  routes/  auth.ts  me.ts  admin.ts  family.ts  booth.ts  guest.ts  display.ts  sim.ts
  realtime/ socket.ts  ticker.ts
  notify/   notify.ts
  index.ts
/server/scripts/simulate.ts
/web/src/app
  core/      auth, api, socket, theme.service.ts, role-switcher
  theme/     themes.ts  motifs/ (SVG components)  splash.component.ts
  venue-map/ venue-map.component.ts (shared SVG map: view + edit modes)
  guest/  booth/  family/  admin/  display/
```

---

## 2. Roles & accounts

Everyone logs in with **phone + OTP**. Roles are **per wedding** (a cousin can be a booth handler *and* a guest). Roles live in `memberships`, never in the JWT, so changes apply instantly.

| Role | Who | Home route |
|---|---|---|
| **Admin** | Wedding planner / organiser. Whoever creates a wedding becomes its admin; can add co-admins | `/admin/:weddingId` |
| **Family Coordinator** | One or two people per side (Bride side / Groom side) | `/family/:weddingId` |
| **Booth Handler** | Mehendi artist, makeup assistant, stage coordinator, caterer's supervisor, valet lead | `/booth/:weddingId` |
| **Guest** | Anyone who scans the venue QR or claims a Family Pass | `/w/:weddingId` |
| **Display** | A TV/tablet. Not a user — opens a secret display link | `/display/:displayToken` |

After login → `/me` lists weddings + roles → user picks (auto-redirect if only one). A role switcher sits in the header for multi-role users.

### Permission matrix
| Action | Admin | Coordinator | Booth Handler | Guest |
|---|---|---|---|---|
| Wedding settings, venue, events, layout, booths | ✅ | — | — | — |
| Add/remove members & assign roles | ✅ | — | — | — |
| Set Family Pass quotas | ✅ | view own side | — | — |
| Generate / revoke / reset passes | ✅ both sides | ✅ own side only | — | — |
| Mark slots *family-only*, pre-book for family | ✅ | ✅ own side | — | — |
| Booth operations (call, start, done, skip, pause, rounds, check-in) | ✅ any booth | — | ✅ assigned booths only | — |
| Join queue / book slot / cancel / away | ✅ (as guest) | ✅ (as guest) | ✅ (as guest) | ✅ |
| Live overview dashboard | ✅ | read-only | own booths | — |

Implemented as one middleware: `requireRole(['admin','coordinator'], { side?, boothId? })` that loads membership from DB and checks side/booth scope. Unit-test `engine/rbac.ts` with the matrix above as a table-driven test.

---

## 3. The 10 events (seeded catalog)

Each event has: `type`, display name, default zone(s), default booths, and a **theme**. Admin can rename, retime, enable/disable any event.

| # | Event | Default booths (mode) |
|---|---|---|
| 1 | **Nichayathartham / Engagement** | Stage photo (live), Welcome drinks (live) |
| 2 | **Haldi** | Haldi application to bride/groom (live, groups), Photo booth (live), Flower jewellery (live) |
| 3 | **Mehendi** | Mehendi artist ×2 (live), Nail art (live), Bangle stall (live), Chaat counter (live) |
| 4 | **Sangeet** | Performance slots for families (slot), Song request desk (live), Mocktail bar (live) |
| 5 | **Cocktail Night** | Bar ×2 (live), Photo booth (live) |
| 6 | **Mappillai Azhaippu / Baraat** | Safa/turban tying (live), Dhol photo point (live) |
| 7 | **Muhurtham / Wedding Ceremony** | Blessing queue to the couple (live, groups), Akshathai & flower desk (live) |
| 8 | **Kalyana Virundhu / Wedding Feast** | Dining hall seating rounds — *pandhi* (batch) |
| 9 | **Reception** | Stage photo (live, groups), Gift counter (live), Live dosa & jalebi counters (live) |
| 10 | **Vidaai & Departures** | Valet car pickup (live), Thamboolam / return-gift bag (live), Travel desk — cabs to station/airport (live) |

Sangeet performance slots, bridal makeup and family portraits use **slot** mode (any event can add a slot booth: "Makeup — Bride's room", "Family portrait").

---

## 4. Theme system ("super awesome" UI, built practically)

**Principle:** one component library, re-skinned by **design tokens**. Every screen is built once; the event's theme changes the colors, display font, background motif and splash animation. No per-event screens.

### 4.1 Tokens (`web/src/app/theme/themes.ts`)
```ts
interface EventTheme {
  key: EventType;
  primary: string; accent: string; bg: string; surface: string; text: string;
  displayFont: string;          // Google Font, lazy-loaded per theme
  motif: MotifName;             // SVG pattern component
  splash: 'petals' | 'sparkle' | 'confetti' | 'rings' | 'leaves' | 'lanterns';
  dark: boolean;
}
```
Applied by `ThemeService.apply(theme)` → sets CSS variables on `<body>` + `data-theme`. Tailwind config maps `primary/accent/bg/surface/text` to those variables (`rgb(var(--primary) / <alpha-value>)`), so every `bg-primary`, `text-accent` re-skins automatically.

| Event | Primary | Accent | Background | Display font | Motif | Splash |
|---|---|---|---|---|---|---|
| Engagement | `#B76E79` rose gold | `#E8C1A0` | `#FFF8F3` | Cormorant Garamond | Interlocking rings | rings |
| Haldi | `#F4B400` turmeric | `#FF8C00` marigold | `#FFF9E0` | Baloo 2 | Marigold strings | petals (marigold) |
| Mehendi | `#3E7C3A` henna green | `#B5532A` terracotta | `#F3F7EC` | Yatra One | Paisley line art | leaves |
| Sangeet | `#FF3EA5` neon pink | `#7C5CFF` violet | `#140B24` (dark) | Unbounded | Equaliser waves | confetti |
| Cocktail | `#D4AF37` champagne | `#E5E5E5` | `#0E0E0E` (dark) | Poiret One | Art-deco fans | sparkle |
| Baraat | `#E25822` saffron | `#7B1E1E` maroon | `#FFF3EA` | Rozha One | Thoranam bunting | confetti |
| Muhurtham | `#9E1B1B` temple red | `#D4A017` gold | `#FFF6E5` | Cinzel | Kolam + mango leaves | petals (jasmine) |
| Wedding Feast | `#2F6B2F` banana-leaf | `#C8A24A` | `#F7F1DE` | Baloo Thambi 2 | Banana leaf | leaves |
| Reception | `#1B2A6B` royal blue | `#C9A86A` | `#F5F3EE` | Playfair Display | Chandelier sparkle | sparkle |
| Vidaai | `#8E7CC3` lavender | `#F6B99A` peach | `#FBF6F2` | Kalam | Paper boats | lanterns |

Check every pair for WCAG AA contrast (text on bg, text on primary) — adjust shades if they fail.

### 4.2 Motion & feel
- **Welcome splash (1.5 s)** on QR scan: couple names → event name in display font → motif animates in → fades into the map. Skippable on tap.
- **Theme cross-fade** (400 ms) when the live event changes — guests' phones re-theme live when admin flips an event to live (great demo moment).
- **"Your turn" takeover:** full-screen, theme-coloured, pulsing token code, vibration `[300,100,300]`, confetti/petals burst.
- Bottom sheets for booth details, skeleton loaders, haptic-like micro-interactions on buttons.
- Respect `prefers-reduced-motion` (no splash/confetti, instant theme swap).
- Mobile-first for guest/booth/family; desktop layout for admin; TV is 16:9 dark-mode always (themed accents).

### 4.3 Venue map (the hero visual)
A single SVG component `venue-map` used in **view** (guest, TV, admin live) and **edit** (admin layout) modes.

- **Hall templates** (pick one, then tweak — no drawing from scratch):
  1. *Kalyana Mandapam* — main hall with stage, dining hall, bride's room, groom's room, entrance foyer, parking
  2. *Banquet Hall* — ballroom, pre-function area, dining, green rooms, porch
  3. *Lawn + Hall* — open lawn, shamiana, indoor hall, buffet tent, parking
- Template = list of **zones** (named rectangles in a `1000×700` viewBox, with icon + fill style).
- **Booths** are pins inside zones (`x_pct`, `y_pct`), drawn with service icon + live wait badge:
  green < 10 min · amber 10–25 · red > 25 · grey paused · lock icon = family-only.
- Each **event uses a subset of zones**; zones not used by the live event are dimmed.
- Guest map: pinch-zoom/pan (CSS transform), tap pin → bottom sheet (wait, options, Join / Book).
- Optional: admin uploads a floor-plan photo as a faded background under the zones.

---

## 5. Data model (SQLite)

```sql
users          (id, phone UNIQUE, name, created_at)
otp_codes      (phone, code_hash, expires_at, attempts)
weddings       (id, name, couple_names, venue_lat, venue_lng, radius_m DEFAULT 150,
                template_key, floorplan_path, qr_secret, created_at)
memberships    (id, wedding_id, user_id, role CHECK(role IN ('admin','coordinator','booth_handler','guest')),
                side NULL CHECK(side IN ('bride','groom')),        -- coordinators, family guests
                UNIQUE(wedding_id, user_id, role))
booth_handlers (booth_id, user_id, PRIMARY KEY(booth_id, user_id))
zones          (id, wedding_id, name, kind, x, y, w, h, icon)       -- viewBox units
events         (id, wedding_id, type, name, starts_at, ends_at, enabled,
                status_override CHECK(status_override IN ('auto','live','ended')) DEFAULT 'auto',
                zone_ids_json, sort_order)
booths         (id, event_id, zone_id, name, service_type, mode CHECK(mode IN ('live','slot','batch')),
                x_pct, y_pct, options_json,                         -- [{label, minutes}]
                visibility CHECK(visibility IN ('public','family','bride','groom')) DEFAULT 'public',
                artists INTEGER DEFAULT 1,                          -- live: parallel servers; slot: capacity per slot
                slot_minutes, round_seats, round_minutes,
                speed_factor REAL DEFAULT 1.0, regulars_since_vip INTEGER DEFAULT 0,
                paused INTEGER DEFAULT 0, opens_at, closes_at)
slots          (id, booth_id, starts_at, capacity, family_only INTEGER DEFAULT 0)
rounds         (id, booth_id, round_no, status CHECK(status IN ('seating','done')), started_at, ends_at)
pass_quotas    (event_id, side, max_passes, PRIMARY KEY(event_id, side))
family_passes  (id, wedding_id, side, token UNIQUE, label, relation, created_by,
                claimed_by_user_id NULL, claimed_at, revoked_at, created_at)
pass_events    (pass_id, event_id, PRIMARY KEY(pass_id, event_id))
presence       (user_id, wedding_id, method CHECK(method IN ('geo','code')), verified_at, valid_until)
tickets        (id, booth_id, event_id, user_id, code,                -- "M-014"
                option_label, base_minutes, party_size DEFAULT 1, is_vip,
                status CHECK(status IN ('waiting','away','called','serving','done','no_show','cancelled')),
                seq REAL, skip_count DEFAULT 0, passed_over DEFAULT 0,
                slot_id NULL, round_id NULL, checked_in_at NULL, away_since NULL,
                joined_at, called_at, serving_at, done_at)
displays       (id, wedding_id, token UNIQUE, label, zone_id NULL, revoked_at)
notifications  (ticket_id, kind, sent_at, PRIMARY KEY(ticket_id, kind))  -- dedupe
audit_log      (id, wedding_id, user_id, action, payload_json, at)
```

**Integrity rules enforced by the DB**
- One active ticket per user per booth:
  `CREATE UNIQUE INDEX one_active_per_booth ON tickets(user_id, booth_id) WHERE status IN ('waiting','away','called','serving');`
- All mutations run inside `tx(() => ...)` — a wrapper in `db/db.ts` over `node:sqlite`: `BEGIN IMMEDIATE` → run → `COMMIT`, `ROLLBACK` on throw. `DatabaseSync` is synchronous, so there are no race conditions on quotas, slot capacity or seq. Call `tx` only at the top level of a route handler (no nesting). If Jest cannot resolve the prefix-only `node:sqlite` module in API tests, use Vitest for the server tests.

```ts
import { DatabaseSync } from 'node:sqlite';
export const db = new DatabaseSync(process.env.DB_PATH ?? 'varisai.db');
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
```

---

## 6. Event lifecycle

```
isLive(event, now) =
  enabled AND (status_override = 'live'
               OR (status_override = 'auto' AND starts_at - 30min <= now < ends_at))
```
- Booking is allowed only for booths of **live** events (slot pre-booking by family is the exception, §9).
- Multiple events can be live at once (e.g., Muhurtham in main hall + Feast in dining hall) → guest sees an event switcher (chips at top, each in its own theme colour). Default = the event whose zones include the booth QR they scanned, else the most recently started.
- Ticker emits `event:status` when an event goes live/ends → guest apps re-theme, open tickets of ended events become `cancelled` with a notice.
- **Admin "Go live now" toggle** = `status_override='live'` — essential for demos at any time of day.

---

## 7. Presence (only people at the venue can book)

### 7.1 Entry points
- **Venue QR** (printed standee at entrance) → `/w/:weddingId`
- **Booth QR** (printed at each counter) → `/w/:weddingId?booth=:boothId` → opens straight into that booth's sheet
- **Family Pass QR** → `/p/:token` (§8)
- **TV rotating code** — fallback when GPS fails indoors

### 7.2 Verification (`engine/presence.ts`)
Pass if **either**:
1. **Geofence:** `haversine(user, venue) − min(accuracy, 100) ≤ radius_m`. Reject if `accuracy > 500` (too vague) → prompt for TV code.
2. **Rotating code:** `window = floor(now / 30s)`; `h = HMAC_SHA256(qr_secret, window)`; QR token = first 8 hex of `h`; manual code = `parseInt(h.slice(0,8),16) % 10000` zero-padded. Accept `window` and `window−1` only. Screenshots forwarded to WhatsApp die within ~60 s.

On success → upsert `presence(valid_until = end of today's last live event, max 12 h)`. Guest routes that **create** tickets/bookings/check-ins require valid presence. Cancel/away/view do not.

Geolocation needs HTTPS → deployed URL, or `localhost` for dev; for phone testing on LAN use the deployed build or a tunnel.

---

## 8. Family Passes (limited, single-use VIP QR per side per event)

### 8.1 Concept
Admin sets a **quota per event per side**, e.g. Mehendi → Bride side 40, Groom side 25. Coordinators generate **named passes** (e.g. "Lakshmi Chithi — Mother's sister") covering one or more events. Each pass is a QR/link that **binds to the first phone that claims it**. Every pass×event pair consumes one unit of that event's quota for that side.

### 8.2 Benefits of a claimed pass (for the events it covers)
1. **Priority lane** in live queues (1 VIP per 3 regulars, §10.1).
2. Access to **family-only booths** (visibility `family`, or `bride`/`groom` for side-specific ones like "Bride's room makeup").
3. **Pre-booking** of slot booths (bridal makeup, family portraits, Sangeet performance) without presence, and access to `family_only` slots.
4. Gold "Family" badge on their tickets (booth handler sees it).
A pass never bypasses presence for live queues.

### 8.3 Generate (coordinator) — `engine/passes.ts#generate`
```
input: side, label, relation, eventIds[], actor
assert actor is admin OR (coordinator AND actor.side == side)
transaction:
  for each eventId:
     used = COUNT(pass_events pe JOIN family_passes p ON p.id = pe.pass_id
                  WHERE pe.event_id = eventId AND p.side = side AND p.revoked_at IS NULL)
     limit = pass_quotas(eventId, side).max_passes   (missing row → 0)
     if used + 1 > limit → throw QuotaExceeded(eventId, used, limit)
  token = randomBytes(16).base64url          // 128-bit, unguessable
  insert family_passes + pass_events
  audit_log
return { pass, url: /p/{token}, qrDataUrl }
```
All-or-nothing: if any event is full, nothing is created and the UI names the full event.
**Bulk generate:** CSV paste of `name, relation` + event checkboxes → same transaction, stops cleanly at quota.

### 8.4 Claim (guest) — `engine/passes.ts#claim`
```
guest opens /p/{token} → login with OTP if needed
pass = find by token
if !pass or pass.revoked_at        → "This pass is no longer valid"
if all its events have ended       → "This pass has expired"
if pass.claimed_by == user         → OK (idempotent)
if user already holds another unrevoked pass in this wedding → "You already have a family pass"
UPDATE family_passes SET claimed_by_user_id = user, claimed_at = now
       WHERE id = pass.id AND claimed_by_user_id IS NULL
if changes == 0                    → "Already claimed by ••••{last4}" (coordinator can reset)
upsert membership(guest, side = pass.side)
recompute is_vip on user's waiting tickets for covered events
```

### 8.5 Revoke / Reset
- **Revoke:** `revoked_at = now` → quota units freed instantly; user's waiting tickets for those events → `is_vip = 0`; their bookings in `family_only` slots → `cancelled` + notification.
- **Reset claim** (wrong person claimed / phone changed): new token, `claimed_by = NULL`; old QR stops working; quota unchanged.

### 8.6 VIP resolution (single source of truth)
```
isFamilyFor(user, event) = EXISTS pass p JOIN pass_events pe
   WHERE p.claimed_by_user_id = user AND p.revoked_at IS NULL AND pe.event_id = event.id
familySide(user) = that pass's side
```
`tickets.is_vip` is a cached copy set at join time and recomputed on claim/revoke.

---

## 9. Booking rules (guest)

- **Max 3 active tickets per user per event** across all modes (`waiting|away|called|serving`). Max 1 per booth (DB index).
- Booth must be in a live event, not paused, within `opens_at..closes_at`, and visible to the user (`public`, or `family`/`bride`/`groom` matching their pass).
- Requires valid presence — except family pass holders **pre-booking slots**.
- Party size: 1 for live booths by default; `stage`, `blessing`, `haldi`, `feast`, `portrait` accept 1–12.
- Cancel any time before `serving`.

---

## 10. Queue engines (pure, deterministic, fully tested)

### 10.1 Live mode (`engine/live.ts`) — mehendi, stage, food, valet…

**Ticket state machine**
```
waiting ──callNext──▶ called ──start──▶ serving ──done──▶ done
   │  ▲                 │
   │  └──skip (1st)─────┤  (manual skip, or auto after 3 min not started)
   │                    └──skip (2nd)──▶ no_show
   ├──guest "I'm away"──▶ away ──"I'm back"──▶ waiting   (away > 20 min → no_show)
   └──cancel──▶ cancelled
```

**`callNext(booth, now)`**
```
if booth.paused or count(called|serving at booth) >= booth.artists → return null
candidates = tickets WHERE booth AND status='waiting' ORDER BY seq
vips = candidates.filter(is_vip); regs = candidates.filter(!is_vip)
preferVip = vips.length > 0 AND (booth.regulars_since_vip >= 3 OR regs.length == 0)
ordered = preferVip ? [...vips, ...regs] : [...regs, ...vips]

pick = first t in ordered where !hasConflict(t.user, now)
       // conflict = user has another ticket in called|serving,
       //            OR was called at another booth in the last 10 min
if !pick: pick = ordered[0]          // never leave an artist idle
booth.regulars_since_vip = pick.is_vip ? 0 : booth.regulars_since_vip + 1
pick.status = 'called'; pick.called_at = now
return pick
```
Deferred guests **keep their seq**, so they're first in line once free.

**`skip(ticket, now)`**
```
ticket.skip_count += 1
if skip_count >= 2 → status = 'no_show'
else:
  waitingAfter = waiting tickets at booth with seq > ticket.seq, ordered
  ticket.seq = waitingAfter.length >= 3 ? waitingAfter[2].seq + 0.5
                                         : (max seq at booth) + 1
  ticket.status = 'waiting'; called_at = NULL
```

**`start`** → `serving_at = now`. **`done`** → `done_at = now`, then learn:
```
actual = (done_at - serving_at) in minutes
ratio  = clamp(actual / ticket.base_minutes, 0.3, 3)
booth.speed_factor = 0.7 * booth.speed_factor + 0.3 * ratio
```
Booth handler's screen auto-runs `callNext` after `done` if "auto-call" toggle is on.

**Durations**
```
estMinutes(t) = t.base_minutes * booth.speed_factor * groupFactor(t)
groupFactor   = service in (stage, blessing, haldi) ? 1 + 0.15 * (party_size - 1) : 1
```

### 10.2 Slot mode (`engine/slot.ts`) — bridal makeup, Sangeet performances, family portraits

- Slots generated when booth is saved: from `opens_at` to `closes_at` step `slot_minutes`, `capacity = booth.artists`. Admin/coordinator can flag slots `family_only`.
- **Book:**
  ```
  transaction:
    assert slot.starts_at > now
    assert !slot.family_only OR isFamilyFor(user, event)
    assert public guests: presence valid AND slot.starts_at <= now + 3h
    assert family: any time (pre-booking allowed)
    booked = COUNT(tickets WHERE slot_id AND status NOT IN ('cancelled','no_show'))
    assert booked < slot.capacity
    insert ticket(status='waiting', slot_id)
  ```
- **Check-in window:** `starts_at − 15 min … starts_at + 10 min`, requires presence → `checked_in_at`.
- **Ticker:** at `starts_at − 10 min` notify "Your slot is in 10 min — check in"; at `starts_at` checked-in tickets → `called`; at `starts_at + 10 min` not checked-in → `no_show` (slot capacity frees, shown as "1 slot just opened").
- Booth handler sees a timeline of today's slots with checked-in ✅ / pending ⏳ / no-show ✕.

### 10.3 Batch mode (`engine/batch.ts`) — Wedding Feast seating rounds (*pandhi*)

Booth has `round_seats` (e.g. 120) and `round_minutes` (e.g. 25). Families join with party size; nobody stands at the dining hall door.

**`buildRound(waiting, seats)`** (also used for dry-runs/ETA)
```
queue = waiting (not away) ORDER BY seq
locked = queue.filter(t => t.passed_over >= 2)        // anti-starvation for big families
round = []; left = seats
for t in locked (seq order): if t.party_size <= left → add t   // locked first
for t in queue minus locked (seq order):                        // then first-fit
    if t.party_size <= left → add t
    if left == 0 → break
// never split a family
skippedEarlier = tickets in queue with seq < last added seq AND not in round
return { round, skippedEarlier, seatsLeft: left }
```
**`startNextRound(booth, now)`** (handler taps, or ticker when previous round's `ends_at` passed and handler enabled auto):
```
transaction:
  previous seating round → status 'done', its tickets → 'done'
  { round, skippedEarlier } = buildRound(...)
  insert rounds(round_no+1, status='seating', started_at=now, ends_at=now+round_minutes)
  round tickets → 'called', round_id set
  skippedEarlier.passed_over += 1
notify round tickets: "Round 5 — Dining hall, please come now"
notify next projected round: "You're in the next round (~N min)"
```
VIP family tickets are placed first within each round (`locked` → VIP → rest), but a family is never split.

### 10.4 ETA (`engine/eta.ts`)
- **Live:** dry-run `callNext` repeatedly on a cloned state (respecting VIP ratio and `artists` parallelism with a simple min-heap of artist free-times) until the ticket is picked → `{ position, minutes }`. Show as range: `minutes … minutes × 1.3`, rounded to 5.
- **Slot:** `slot.starts_at − now`.
- **Batch:** dry-run `buildRound` repeatedly → `roundsAhead × round_minutes + remaining time of current round`.
- Recomputed for a booth on every mutation; ticker re-broadcasts every 30 s.

### 10.5 Ticker (`realtime/ticker.ts`, every 10 s)
1. Auto-skip `called` live tickets not started within 3 min.
2. `away` > 20 min → `no_show`.
3. Slot notifications, slot call, slot no-show release.
4. Batch auto-round (if enabled).
5. Event status transitions → `event:status`.
6. "Almost your turn" (position ≤ 2) notifications, deduped via `notifications` table.

---

## 11. Notifications (`notify/notify.ts`)
| Kind | Trigger | Channels |
|---|---|---|
| `almost` | position ≤ 2 / next round / slot −10 min | socket + browser Notification |
| `called` | status → called | socket takeover + vibration + Notification + WhatsApp (if Twilio set) |
| `skipped` | first skip | socket + Notification ("moved back 3 places — tap I'm here") |
| `cancelled` | event ended / pass revoked | socket |
`INSERT OR IGNORE INTO notifications(ticket_id, kind)` before sending → each kind sent once per ticket.

---

## 12. API (all JSON, zod-validated, errors as `{ error: code, message }`)

**Auth & me**
`POST /api/auth/otp` · `POST /api/auth/verify` · `POST /api/auth/logout` · `GET /api/me` (user + memberships)
OTP: 6 digits, 5-min expiry, max 5 attempts, max 3 requests / 10 min / phone.

**Admin** (`/api/admin/:w/...`)
`POST /weddings` (creator becomes admin) · `PATCH /` (name, couple, venue, radius, template) ·
`GET|POST|PATCH|DELETE /events` · `POST /events/:id/live` `{override}` ·
`GET|PUT /zones` · `GET|POST|PATCH|DELETE /booths` · `POST /booths/:id/slots/regenerate` ·
`GET|PUT /quotas` · `GET|POST|DELETE /members` `{phone, role, side?, boothIds?}` ·
`GET|POST|DELETE /displays` · `GET /overview` (KPIs) · `POST /import-invite` (stretch)

**Family** (`/api/family/:w/...`)
`GET /quotas` (used/limit per event, own side) · `GET|POST /passes` · `POST /passes/bulk` ·
`POST /passes/:id/revoke` · `POST /passes/:id/reset` · `PATCH /slots/:id` `{family_only}` · `POST /slots/:id/book-for` `{passId}`

**Booth** (`/api/booth/:w/...`)
`GET /booths` (assigned) · `GET /booths/:id/state` · `POST /booths/:id/call-next` · `POST /tickets/:id/start|done|skip` ·
`POST /booths/:id/pause` · `POST /booths/:id/rounds/next` · `POST /tickets/:id/check-in` (manual) · `POST /booths/:id/walk-in` `{name, phone?}` (for elders without phones)

**Guest** (`/api/guest/:w/...`)
`GET /bootstrap` (wedding, live events, themes, zones, booths + waits, my tickets, my pass) ·
`POST /presence` `{lat,lng,accuracy} | {code}` · `POST /tickets` `{boothId, option, partySize}` ·
`POST /slots/:id/book` · `POST /tickets/:id/cancel|away|back|check-in` · `POST /passes/claim` `{token}`

**Display** `GET /api/display/:token/bootstrap` · `GET /api/display/:token/code` (current rotating QR + code)

**Sim** `GET /api/sim` (cached result of §14)

**Socket.io** — handshake authenticated by cookie (display by token). Rooms: `wedding:{w}`, `booth:{b}`, `user:{u}`, `display:{d}`.
Events: `booth:update {boothId, waiting, nowServing[], estWait, paused}` · `ticket:update {ticket, position, eta}` · `ticket:called` · `event:status {eventId, live}` · `round:update` · `code:rotate` (displays, every 30 s).

---

## 13. Screens & dashboards

### Guest (`/w/:w`, mobile)
1. **Scan → Splash** (themed welcome) → **Login** (phone, OTP) → **Presence** ("Allow location" with friendly illustration; fallback "Enter the 4-digit code on the TV").
2. **Home = Venue map** of the live event, event chips on top, "My tickets" tray at bottom (up to 3 cards, swipeable).
3. **Booth sheet:** name, artist, live wait + people ahead, options with minutes, party size stepper → **Join queue** / **Pick a slot** / **Join feast round**.
4. **Ticket card:** code, position, ETA range, progress ring, buttons *I'm away / Cancel*; family badge if VIP.
5. **Your-turn takeover** (full screen).
6. **Family pass** screen (if claimed): side, events covered, perks.

### Booth handler (`/booth/:w`, phone held by artist)
- Booth switcher (if multiple). Huge **Now serving** card (code, name, option, party, family badge, timer since start).
- **Next 3** list. Big buttons: **Call next · Start · Done · Skip**, Pause toggle, Auto-call toggle.
- Slot booths: today's slot timeline with check-in states. Batch booths: round builder showing seats used/left and families in the next round, **Start next round** button.
- **Walk-in** button (add an elder by name).
- Mini-stats: served today, avg minutes, current speed factor.

### Family coordinator (`/family/:w`)
- **Quota meters** per event (used / limit, side-coloured).
- **Generate pass** form (name, relation, event checkboxes) → QR card with *Share on WhatsApp* (Web Share API) and *Download PNG*.
- **Bulk generate** (paste names).
- **Passes table:** label, events, claimed by (masked phone), status; Revoke / Reset.
- **Family slots:** mark slots family-only, book a slot on behalf of a pass holder (e.g., bride's sisters' makeup).

### Admin (`/admin/:w`, desktop)
- **Overview:** KPIs (guests checked in, active tickets, avg wait, longest queue, no-show rate, family passes used), live venue map with heat badges, alerts ("Mehendi 1 wait > 30 min — 2nd artist?").
- **Events:** 10-event timeline (theme-coloured cards), enable/disable, edit times/zones, **Go live now** toggle, preview theme.
- **Venue & layout:** pick template, edit zones (rename, resize via inputs + drag), drag booths from palette onto map (CDK drag-drop), side panel for booth config (mode, options, artists, slot/round settings, visibility, opens/closes, handlers).
- **People:** members table, add by phone with role/side/booths.
- **Family quotas:** grid of events × sides.
- **Displays:** create TV links, open preview.
- **Insights:** simulation chart (§14) + live stats.

### Display / TV (`/display/:token`)
Dark, 16:9, theme accents of the live event. Left 40%: big rotating QR + 4-digit code + 30-s progress ring + "Scan to join any queue". Right: **Now serving** board per booth (zone-filtered if set) + mini venue heat-map. Feast booth shows "Round 5 seating · 18 seats left".

---

## 14. Simulation (proof for judges) — `server/scripts/simulate.ts`, `GET /api/sim`

Seeded RNG; reuses `engine/live.ts` and `engine/batch.ts`.
Scenario: Reception, 400 guests arriving over 2 h; each wants a random 1–3 of {stage (1 photographer, groups), dosa (2), jalebi (1), gift counter (1)} + Feast (120 seats, 25-min rounds).
- **Baseline:** physical lines — guest stands in one line at a time; feast = crowd at the door, first-come seating.
- **Varisai:** up to 3 virtual queues held at once, conflict deferral, batch rounds; guest "stands" only from call → done.
Metrics per strategy: avg standing min/guest, p90 wait, total guest-hours standing, idle artist minutes. Output JSON + console table; admin Insights shows grouped bar chart.

---

## 15. Build order & timeline (≈8 h with Claude Code)

Rule: **one slice per prompt → run tests → test on a real phone → commit.** Checkpoints are hard cut-offs.

| Time | Slice | Done when |
|---|---|---|
| 0:00–0:30 | **S0** Scaffold monorepo, Tailwind + CSS-var theming, schema, seed (§17) | `npm run dev` shows seeded data |
| 0:30–1:45 | **S1** Engines: live, slot, batch, eta, passes, presence, rbac + Jest suites | all green; you've read the live + batch tests |
| 1:45–2:30 | **S2** Auth (OTP demo), memberships, `requireRole`, `/me`, role switcher | each seeded user lands on correct home |
| 2:30–3:45 | **S3** Guest app: splash, themes, venue map (view), booth sheet, join/book, ticket cards, takeover, realtime | ✅ **Checkpoint A:** guest can join a live queue and get called |
| 3:45–4:30 | **S4** Booth handler console (live first, then batch, then slot) | handler calls → guest phone takes over |
| 4:30–5:15 | **S5** Family: quotas, generate, claim, revoke, VIP lane | quota blocks the 41st pass |
| 5:15–6:15 | **S6** Admin: overview, events + Go live, layout editor, members, quotas, displays; TV screen | ✅ **Checkpoint B:** full demo path works |
| 6:15–6:45 | **S7** Notifications polish + simulation + Insights chart | |
| 6:45–7:30 | **S8** README, deploy, Playwright smoke test, record demo | live URL works on phone |
| 7:30–8:00 | Buffer / stretch: import events from invitation (Claude), WhatsApp | |

**If behind at Checkpoint A (3:45):** slot mode → admin-config only (no guest UI); layout editor → template only (no drag); drop bulk passes.
**If behind at Checkpoint B (6:15):** drop simulation live chart (use static screenshot in README), drop walk-in.
**Never cut:** themed guest flow, live engine, family passes with quotas, booth console, TV rotating code.

**Optional parallelism:** two Claude Code sessions in separate git worktrees — one on S1 engines, one on S0 theme system + venue-map component with mock data — merge at 1:45.

---

## 16. Non-goals (put under "Roadmap" in README)
Native apps, payments, offline sync, multi-language UI, indoor positioning/BLE, real SMS in demo, multi-wedding planner billing, guest-to-guest chat, CRDTs.

---

## 17. Seed data (`npm run seed`; auto on empty DB)

- Wedding **"Priya ❤ Arjun"**, template *Kalyana Mandapam*, venue = `SEED_LAT/SEED_LNG`, radius 150 m.
- All **10 events** over 3 days with themes and booths from §3; **Mehendi** and **Wedding Feast** set `status_override='live'` so the demo works at any hour.
- Quotas: every event Bride 40 / Groom 25 (Muhurtham 60/40).
- Users (OTP always `123456`):

| Phone | Role |
|---|---|
| 9000000001 | Admin |
| 9000000002 | Coordinator — Bride side |
| 9000000003 | Coordinator — Groom side |
| 9000000010–15 | Booth handlers (Mehendi 1, Mehendi 2, Stage, Feast, Makeup, Valet) |
| 9000000100–129 | Guests (5 hold claimed family passes) |

- 25 waiting tickets spread across booths, one feast round in progress, a few booked makeup slots → every screen looks alive.
- One display token printed in console on start.

---

## 18. Testing
- **Engine (Jest, table-driven):** live FIFO; VIP 1:3; conflict deferral + idle fallback; skip → back 3 → no_show; away timeout; speed factor learning; artists > 1 parallel calls; slot capacity & family-only & pre-booking rules & no-show release; batch first-fit, no family split, passed_over lock after 2 rounds; ETA monotonicity; pass quota exceed (all-or-nothing), single claim, double-claim rejection, one-pass-per-user, revoke frees quota & strips VIP; presence geofence edge (accuracy), rotating code current/previous/expired window; RBAC matrix.
- **API (supertest):** role guards (coordinator can't touch other side; handler can't operate unassigned booth); max-3-tickets; 409s for duplicates.
- **Playwright smoke:** guest login → presence via code → join Mehendi → handler calls → guest sees takeover.

---

## 19. README must include
Problem (one paragraph) + hero GIF · live URL + demo logins table · `npm install && npm run dev` · env table · architecture diagram (mermaid) · roles & permission matrix · engine rules (live, slot, batch, passes, presence) · simulation results chart · screenshots of all 5 dashboards themed differently · roadmap.

---

## 20. Demo script (2 min)
1. **TV** on screen (Mehendi theme, rotating QR). Judge scans → **henna-green splash** → map → joins *Mehendi 1* (position 3, ~15 min).
2. Show **Bride coordinator** generating a family pass → second judge claims it → their ticket jumps the VIP lane (gold badge).
3. **Booth handler** taps *Call next* → judge's phone: full-screen "Your turn M-014" + vibration.
4. **Admin** flips *Sangeet* to live → every phone **cross-fades to neon** live.
5. Show **Feast** round builder ("Round 5 · 18 seats left") and a phone outside the geofence being refused.
6. Close on the **simulation chart**: standing time cut by X%.
