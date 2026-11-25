# Varisai — Lite Build Plan (6–8 h, Claude Pro budget)

> **One QR for every queue at an Indian wedding.**
> Guests scan a QR at the venue, the app themes itself to the live event, shows the hall map with live waits, and lets them hold places in up to 3 queues at once. Families get limited **Family Passes** for a priority lane. Booth handlers run counters from their phone. The organiser runs events and the layout from a dashboard.

This file is the **downsized** version of `SPEC.md`. It keeps the parts that win a demo and drops everything that costs build time or Claude usage. Where this file and `SPEC.md` disagree, **this file wins**. (Both files now use the name Varisai and `node:sqlite`.)

---

## 0. What changed vs SPEC.md

| Area | Full spec | Lite |
|---|---|---|
| Roles | Admin, Coordinator, Handler, Guest, Display | **Admin, Booth Handler, Guest.** Admin also generates passes for both sides. No Coordinator. TV screen is an admin page, not a separate role |
| Events | 10 seeded | **4 seeded** (Mehendi, Sangeet, Muhurtham, Feast). More are one config row each (§9) |
| Queue modes | live + slot + batch | **live + batch.** Slot booking is roadmap |
| Passes | quotas, bulk, claim, revoke, reset, family-only booths, slot pre-booking | **quotas, generate, claim, revoke, VIP lane only** |
| Presence | geofence + rotating code | Same (it is the core idea). Rotating code is shown on the admin "Venue screen" page |
| ETA | dry-run simulation heap | **Position formula** (§6) |
| Layout | template + drag-drop editor | **One hall template. Click the map to place a booth pin** (no drag library) |
| Notifications | socket + browser + WhatsApp | **Socket takeover + vibration + browser Notification.** No Twilio |
| Theme | tokens + SVG motifs + 6 splash types | **Tokens + CSS pattern + one splash animation** |
| Simulation | script + API + Insights chart | **Script only.** Paste the result table in README |
| Tests | Jest + supertest + Playwright | **Jest engine tests + ~8 supertest cases.** No Playwright |
| Extras | audit log, rate limits, OTP tables, import invite, walk-ins | **Cut** |
| Sponsors | — | **Sarvam AI** voice/translated alerts, **Flagsmith** live flags + one A/B test, **NudgeBee** ops workflow. All optional, keyless = still works (§14) |

---

## 1. Stack

| Layer | Choice |
|---|---|
| Monorepo | npm workspaces: `/server`, `/web` |
| Server | Node LTS, TypeScript, Express, **built-in `node:sqlite`** (no native add-ons; Windows Smart App Control blocks `better-sqlite3`), `socket.io`, `zod`, `jsonwebtoken`, `cookie-parser`, Jest + supertest |
| Web | Angular (standalone, signals), Tailwind (colours from CSS variables), `qrcode`, `html5-qrcode`, `canvas-confetti` |
| Run | `npm install && npm run dev` → seeds DB if empty, runs both apps (`concurrently`) |
| Deploy | Express serves the Angular build; one Render/Railway service |

`.env.example`: `PORT=3000`, `JWT_SECRET=change-me`, `SEED_LAT=13.0827`, `SEED_LNG=80.2707`. OTP is always `123456` (no env switch).
Sponsor keys (all optional, §14): `SARVAM_API_KEY`, `FLAGSMITH_ENVIRONMENT_KEY`, `OPS_TOKEN`, `NUDGEBEE_WEBHOOK_URL`.

```
/server/src
  engine/   live.ts batch.ts passes.ts presence.ts eta.ts  (+ *.test.ts)   # PURE: no I/O, no Date.now(); pass `now`
  db/       schema.sql db.ts seed.ts
  routes/   auth.ts guest.ts booth.ts admin.ts
  realtime/ socket.ts ticker.ts
  index.ts
/server/scripts/simulate.ts
/web/src/app
  core/     auth api socket theme.service.ts
  guest/ booth/ admin/ shared/venue-map
```

---

## 2. Roles

Phone + OTP login. Roles live in `memberships` (per wedding), never in the JWT.

| Role | Home | Can do |
|---|---|---|
| **Admin** | `/admin` | Events (add/edit/Go live), place booths, assign handlers, set pass quotas, generate/revoke passes, overview, venue screen |
| **Booth Handler** | `/booth` | Operate **assigned** booths only: call next, start, done, skip, pause; start next feast round |
| **Guest** | `/w` | View map, verify presence, join/cancel/away, claim a pass |

One middleware: `requireRole(roles, { boothId? })`. One table-driven test for it.

---

## 3. Events and themes (4 seeded)

| Event | Booths (mode) | Primary / Accent / Bg | Font | Splash |
|---|---|---|---|---|
| **Mehendi** *(live override)* | Mehendi table ×2 artists (live), Nail art (live), Chaat counter (live) | `#3E7C3A` / `#B5532A` / `#F3F7EC` | Yatra One | leaves |
| **Sangeet** | Song request desk (live), Mocktail bar (live) | `#FF3EA5` / `#7C5CFF` / `#140B24` dark | Unbounded | confetti |
| **Muhurtham** | Blessing queue to the couple (live, groups 1–12) | `#9E1B1B` / `#D4A017` / `#FFF6E5` | Cinzel | petals |
| **Feast** *(live override)* | Dining hall seating rounds (batch) | `#2F6B2F` / `#C8A24A` / `#F7F1DE` | Baloo Thambi 2 | leaves |

- `themes.ts` is a plain object keyed by event type. `ThemeService.apply()` sets `--primary --accent --bg --surface --text` on `<body>`; Tailwind maps `primary/accent/bg/text` to those variables. Check text-on-bg and text-on-primary pass WCAG AA.
- **Splash (1.5 s, tap to skip):** couple names, then event name in the display font, then fade to the map. `prefers-reduced-motion` → no animation.
- **Theme cross-fade (400 ms)** when the live event changes. This is the demo moment.
- **Your-turn takeover:** full-screen, themed, big token code, `navigator.vibrate([300,100,300])`, confetti.

---

## 4. Venue map (hero visual)

One SVG component `venue-map`, `1000×700` viewBox, **one hard-coded "Kalyana Mandapam" template**: main hall + stage, dining hall, bride's room, groom's room, foyer, parking. Zones are named rectangles.

- Booths are pins at `x_pct, y_pct` with a wait badge: green < 10 min, amber 10–25, red > 25, grey paused.
- Zones not used by the live event are dimmed.
- Tap a pin → bottom sheet (wait, options, Join).
- **Admin layout editing:** pick a booth in a side list, click the map to set its pin. That is the whole editor.

---

## 5. Data model (SQLite)

```sql
users         (id, phone UNIQUE, name, lang DEFAULT 'en-IN')          -- lang: Sarvam §14.1
weddings      (id, name, couple_names, venue_lat, venue_lng, radius_m DEFAULT 150, qr_secret)
memberships   (id, wedding_id, user_id, role CHECK(role IN ('admin','booth_handler','guest')),
               side NULL CHECK(side IN ('bride','groom')), UNIQUE(wedding_id,user_id,role))
events        (id, wedding_id, type, name, starts_at, ends_at,
               status_override CHECK(status_override IN ('auto','live','ended')) DEFAULT 'auto', sort_order)
booths        (id, event_id, name, service_type, mode CHECK(mode IN ('live','batch')),
               x_pct, y_pct, options_json,            -- [{label, minutes}]
               artists INTEGER DEFAULT 1, round_seats, round_minutes,
               speed_factor REAL DEFAULT 1.0, regulars_since_vip INTEGER DEFAULT 0, paused INTEGER DEFAULT 0)
booth_handlers(booth_id, user_id, PRIMARY KEY(booth_id,user_id))
pass_quotas   (event_id, side, max_passes, PRIMARY KEY(event_id,side))
family_passes (id, wedding_id, side, token UNIQUE, label, claimed_by_user_id NULL, revoked_at NULL)
pass_events   (pass_id, event_id, PRIMARY KEY(pass_id,event_id))
presence      (user_id, wedding_id, valid_until, PRIMARY KEY(user_id,wedding_id))
tickets       (id, booth_id, event_id, user_id, code, option_label, base_minutes, party_size DEFAULT 1, is_vip,
               status CHECK(status IN ('waiting','away','called','serving','done','no_show','cancelled')),
               seq REAL, skip_count DEFAULT 0, round_id NULL, joined_at, called_at, serving_at, done_at,
               away_since NULL)                                     -- for the 20-min away timeout
rounds        (id, booth_id, round_no, status CHECK(status IN ('seating','done')), started_at, ends_at)

CREATE UNIQUE INDEX one_active_per_booth ON tickets(user_id, booth_id)
  WHERE status IN ('waiting','away','called','serving');
```

Every mutation runs inside `tx(() => ...)`. `node:sqlite` (`DatabaseSync`) is synchronous and has no `.transaction()` helper, so `db/db.ts` exports this wrapper:

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

Test note: `node:sqlite` is a prefix-only builtin. If Jest cannot resolve it in the supertest suites, switch the server tests to Vitest (same `describe/it/expect` API). Engine tests are pure and unaffected.

Rules: call `tx` only at the top level of a route handler (no nesting). Everything inside it stays synchronous, so quotas and `seq` cannot race. API: `db.prepare(sql).get/all/run(...)`. Use `?` placeholders. `run()` returns `{ changes, lastInsertRowid }`.

---

## 6. Rules (pure functions in `/engine`, fully unit-tested)

### Event live
`isLive = status_override='live' OR (status_override='auto' AND starts_at-30min <= now < ends_at)`. Booking only for live events. Several events can be live at once; the guest sees event chips.

### Presence (`presence.ts`)
Pass if **either**:
1. `haversine(user, venue) - min(accuracy,100) <= radius_m`. Reject if `accuracy > 500` (ask for the code).
2. Rotating code: `w = floor(now/30s)`, `h = HMAC_SHA256(qr_secret, w)`, 4-digit code `= parseInt(h.slice(0,8),16) % 10000`, zero-padded. Accept window `w` and `w-1`.

On success: `presence.valid_until = now + 12h`. Creating a ticket requires valid presence. Cancel/away/view do not.

### Booking rules
Max **3 active tickets per user per event**, max 1 per booth (DB index). Booth must be unpaused and in a live event. Party size 1 by default; `blessing` and `feast` accept 1–12.

### Live queue (`live.ts`)
State: `waiting → called → serving → done`; `waiting ⇄ away`; `skip`; `cancel`.

```
callNext(booth, now):
  if booth.paused or count(called|serving) >= booth.artists: return null
  vips = waiting & is_vip (by seq); regs = waiting & !is_vip (by seq)
  preferVip = vips.length>0 AND (regulars_since_vip >= 3 OR regs.length==0)
  ordered = preferVip ? [...vips,...regs] : [...regs,...vips]
  pick = first t in ordered where user has no other ticket in called|serving
  if !pick: pick = ordered[0]                 # never leave an artist idle
  regulars_since_vip = pick.is_vip ? 0 : +1
  pick.status='called'; pick.called_at=now
```
Deferred guests keep their `seq`, so they go first once free (this is the "3 queues at once" trick).

`skip`: `skip_count += 1`; if `>= 2` → `no_show`; else `seq` = just after the 3rd waiting ticket behind them (or the end if fewer than 3), status `waiting`.
`done`: `ratio = clamp(actual/base_minutes, 0.3, 3)`; `speed_factor = 0.7*speed_factor + 0.3*ratio`.

### ETA (`eta.ts`, deliberately simple)
```
live : ahead = waiting tickets before me (VIP counted first for VIPs)
       minutes = ceil(ahead / artists) * avgBaseMinutes * speed_factor ; show range minutes … minutes*1.3 rounded to 5
batch: roundsAhead = ceil(seatsNeededAheadIncludingMe / round_seats)
       minutes = (roundsAhead - 1) * round_minutes + minutesLeftInCurrentRound
```
Recompute for a booth on every mutation.

### Feast rounds (`batch.ts`)
```
buildRound(waiting by seq, seats):
  round=[]; left=seats
  VIPs first (seq order), then the rest (seq order)
  add t if t.party_size <= left            # first-fit; never split a family
```
`startNextRound`: previous round tickets → `done`; build round; tickets → `called`; notify them and the next group. (No anti-starvation lock in Lite. Mention it in README roadmap.)

### Family Passes (`passes.ts`)
- Admin sets `pass_quotas(event, side, max)`.
- **generate(side, label, eventIds):** in one transaction, for each event `used + 1 <= max` else throw `QuotaExceeded(eventId)`. All-or-nothing. Token = `randomBytes(16).base64url`. Returns `/p/{token}` and a QR.
- **claim(token, user):** reject revoked; idempotent for the same user; one pass per user per wedding; `UPDATE ... WHERE claimed_by_user_id IS NULL` and if 0 rows changed → "already claimed". Then recompute `is_vip` on the user's waiting tickets.
- **revoke:** set `revoked_at` (frees quota), clear `is_vip` on affected waiting tickets.
- `isFamilyFor(user, event)` = claimed, unrevoked pass covering that event. `tickets.is_vip` is cached at join time.
- A pass never bypasses presence.

### Ticker (one `setInterval`, 10 s)
1. `called` live ticket not started within 3 min → `skip`.
2. `away` > 20 min → `no_show`.
3. Event went live/ended → emit `event:status`; tickets of ended events → `cancelled`.
4. Position ≤ 2 → send `almost` once per ticket (in-memory `Set`, no table).

---

## 7. API (JSON, zod-validated, errors `{error, message}`)

```
Auth    POST /api/auth/otp {phone}            → always ok
        POST /api/auth/verify {phone, otp}    → cookie JWT (otp must be 123456)
        GET  /api/me                          → user + memberships
Guest   GET  /api/guest/bootstrap             → wedding, live events + themes, zones, booths + waits, my tickets, my pass
        POST /api/guest/presence {lat,lng,accuracy} | {code}
        POST /api/guest/tickets {boothId, option, partySize}
        POST /api/guest/tickets/:id/cancel|away|back
        POST /api/guest/passes/claim {token}
Booth   GET  /api/booth/booths                → assigned booths with state
        POST /api/booth/booths/:id/call-next | pause | rounds/next
        POST /api/booth/tickets/:id/start | done | skip
Admin   GET|POST|PATCH /api/admin/events ; POST /api/admin/events/:id/live {override}
        GET|POST|PATCH /api/admin/booths ; PATCH /api/admin/booths/:id/pin {x_pct,y_pct}
        POST /api/admin/booths/:id/handlers {phone}
        GET|PUT /api/admin/quotas ; GET|POST /api/admin/passes ; POST /api/admin/passes/:id/revoke
        GET  /api/admin/overview ; GET /api/admin/venue-code   → current rotating code + QR token
```
**Socket.io** rooms `wedding:{id}`, `booth:{id}`, `user:{id}`. Events: `booth:update`, `ticket:update`, `ticket:called`, `event:status`, `code:rotate`.

---

## 8. Screens

**Guest (mobile)** → scan → themed splash → phone + OTP → presence ("Allow location", fallback "Enter the 4-digit code on the venue screen") → **map** with event chips and a tray of up to 3 ticket cards → booth sheet (wait, options, party stepper, Join) → ticket card (code, position, ETA range, *I'm away / Cancel*, gold family badge) → your-turn takeover → family-pass screen if claimed.

**Booth handler (mobile)** → booth switcher; big **Now serving** card with timer; **Next 3**; buttons **Call next · Start · Done · Skip**; Pause toggle; feast booths show the round builder (seats used/left) and **Start next round**.

**Admin (desktop)** tabs:
- **Overview:** KPIs (checked in, active tickets, avg wait, longest queue, passes used), live map with badges.
- **Events:** list with theme-colour cards, add/edit, **Go live now** toggle.
- **Layout:** map + booth list; select a booth, click the map to place its pin; assign handlers by phone; add a booth (name, mode, options, artists).
- **Passes:** quota grid (event × side), generate form (label, side, event checkboxes) → QR card with Web Share and Download PNG, passes table with Revoke.
- **Venue screen:** fullscreen dark page with rotating QR + 4-digit code + 30-s ring + "Now serving" per booth. Open this on the demo TV or a second laptop.

---

## 9. Seed data (`npm run seed`, auto on empty DB)

- Wedding **"Priya ❤ Arjun"**, venue = `SEED_LAT/SEED_LNG`, radius 150 m.
- The 4 events and their booths from §3. Mehendi and Feast have `status_override='live'` so the demo works at any hour.
- Quotas: every event Bride 40 / Groom 25.
- Users (OTP `123456`): `9000000001` Admin · `9000000010` Mehendi handler · `9000000011` Feast handler · `9000000012` Sangeet + Blessing handler · `9000000100–109` guests (3 hold claimed passes).
- ~15 waiting tickets spread across booths and one feast round in progress.
- **Adding more events later** (Haldi, Reception, …) = one `events` row + one `themes.ts` entry + booths. No new screens.

---

## 10. Tests (keep it small)

- **Engine, Jest table-driven:** FIFO; VIP 1:3; conflict deferral with idle fallback; skip → back 3 → no_show; speed-factor learning; parallel artists; batch first-fit with no family split; ETA monotonic; pass quota all-or-nothing; single claim and double-claim rejection; revoke frees quota; presence geofence edge and code window (current / previous / expired); RBAC matrix.
- **supertest (~8 cases):** handler cannot operate an unassigned booth; guest without presence gets 403 on join; 4th ticket rejected; duplicate join 409; 41st bride pass rejected; revoked pass cannot be claimed.
- No Playwright. Do one manual end-to-end run on a real phone before recording.

---

## 11. Build plan against the Pro limit

Rule: **one slice per prompt, `/clear` between stages, commit after each.** **Claude builds everything, server and UI.** The "You do" column is only what Claude can't do: accounts, keys, deploy clicks, the phone test and the recording.

| Stage | Claude does | You do | Done when |
|---|---|---|---|
| **S0** | Schema + seed + Express skeleton; `ng new`, Tailwind, workspaces, theme vars | `.env` | `npm run dev` shows seeded data |
| **S1** | All `/engine` files + tests (prompts 1–2) | Read `live` + `batch` tests once | Tests green |
| **S2** | Auth, `requireRole`, routes for guest + booth | — | Seeded users land on correct home (API) |
| **S3** | Guest bootstrap + socket wiring | — | Socket events fire |
| **S4** | Booth routes (done in S2) + feast round logic hookup | — | Feast rounds via API |
| **S5** | Passes routes + tests | — | 41st bride pass blocked (API) |
| **S6** | Admin routes (events, booths, quotas, overview, venue-code) | — | Admin API tests green |
| **U1** | Web core: `api`, `auth`, `socket`, `theme.service` + `themes.ts`, login (phone + OTP), role guards, home redirect | — | Seeded users land on the correct home **in the browser** |
| **U2** | Guest flow: splash, presence (geo + code), `venue-map` SVG, event chips, booth sheet, ticket tray, your-turn takeover, live socket updates | — | **Checkpoint A:** guest joins a queue and gets called |
| **U3** | Handler console: booth switcher, Now serving + timer, Next 3, Call next/Start/Done/Skip, Pause, feast round builder | — | Handler call → guest phone takes over |
| **U4** | Admin tabs: Overview, Events, Layout (click-to-place pin, handlers, add booth); Venue screen | — | Venue screen code works for presence |
| **U5** | Passes tab (quota grid, generate form, QR card with Share/Download, table with Revoke) + guest claim screen `/p/:token` | — | **Checkpoint B:** full demo path works |
| **S6.5** | Sponsors §14: Sarvam → Flagsmith → NudgeBee endpoints + their UI bits | Sponsor accounts + keys, NudgeBee workflow on its canvas | Voice alert plays; flag flip changes phones; NudgeBee approval opens a 2nd artist |
| **S7** | `simulate.ts`, README, Express serves the Angular build | Deploy to Render, record demo | Live URL works on phone |
| Buffer | Bug fixes only | Screenshots | |

**If behind at Checkpoint A (U2):** drop the feast batch UI (keep live queues only).
**If behind at Checkpoint B (U5):** drop the simulation and put a static comparison table in the README.
**Sponsor cut order (if S6.5 runs long):** NudgeBee webhook-out first (keep the schedule-triggered workflow) → Flagsmith A/B (keep kill-switch flags) → Sarvam translation (keep TTS). Sarvam TTS is the last to go.
**Never cut:** themed guest flow, live engine, family passes with quotas, presence with rotating code, booth console.
Sign up for Sarvam, Flagsmith and NudgeBee **during S1–S2** (while Claude works) so keys are ready by S6.5.

**When you hit the usage limit:** commit, write the next prompt into `TODO.md`, then do sponsor sign-ups, deploy setup or the phone test until the window resets. Start each U stage in a fresh window.

---

## 12. Demo script (2 min)

1. **Venue screen** on a second device shows the rotating QR. A judge scans it, sees the green Mehendi splash, then the map, and joins *Mehendi table* (position 3, ~15 min).
2. **Admin** generates a Bride-side Family Pass; a second judge claims it and their ticket jumps the lane (gold badge). Show the quota meter blocking the 41st pass.
3. **Handler** taps *Call next* → the judge's phone goes full-screen "Your turn" with vibration.
4. **Admin** flips *Sangeet* to live → every phone cross-fades to neon.
5. Show the **Feast** round builder ("Round 5 · 18 seats left") and a phone outside the geofence being refused.
6. Close on the simulation table: guest standing time with virtual queues vs physical lines.

---

## 13. README must include

Problem (one paragraph) · live URL + demo logins table · `npm install && npm run dev` · env table · roles table · engine rules (live, feast rounds, passes, presence) · simulation table · screenshots of guest (2 themes), handler, admin · **"Built with" section: one paragraph + screenshot per sponsor (Sarvam, Flagsmith, NudgeBee workflow canvas)** · **Roadmap:** slot booking, family-only booths, coordinator role, 6 more events, drag layout editor, WhatsApp alerts, anti-starvation for large families.

---

## 14. Sponsor integrations (stage S6.5)

**Rule for all three:** optional and keyless-safe. Missing key → feature hidden or default used, never an error. Sponsor calls are async, have a 3 s timeout, and run **after** the DB transaction commits. A ticket is never delayed or failed because a sponsor API is slow. Keys are server-side only.

### 14.1 Sarvam AI — "Your turn" in the guest's language (`server/src/sponsors/sarvam.ts`)
- `users.lang` (default `en-IN`). Guest picks a language on the presence screen: English, தமிழ் `ta-IN`, हिन्दी `hi-IN`, ಕನ್ನಡ `kn-IN`, తెలుగు `te-IN`, മലയാളം `ml-IN`.
- On `ticket:called`: build the English line (`"{name}, it's your turn at {booth}. Token {code}."`) → **Mayura translate** to `users.lang` → **Bulbul TTS** → base64 audio. Emit `ticket:voice {ticketId, text, audio}` to `user:{id}`. The takeover plays it (one tap-to-unlock "Enable voice alerts" button on first visit satisfies browser autoplay rules).
- Cache audio by `(lang, text)` in memory: repeated calls cost nothing.
- Translate the `almost` and feast-round messages too (text only, no audio).
- Check endpoint names, the auth header (`api-subscription-key`) and model ids against the Sarvam API reference when building. Don't guess.

### 14.2 Flagsmith — live kill-switches + one A/B test (`server/src/sponsors/flags.ts`)
- Server uses `flagsmith-nodejs` with the environment key. It refreshes every 15 s and emits `flags:update` on change, so phones update live without a reload.
- Defaults when no key (all on):

| Flag | Type | Effect |
|---|---|---|
| `family_passes` | bool | Hides pass claim and the VIP lane (VIP ratio → off) |
| `feast_rounds` | bool | Hides the Feast booth sheet's Join button |
| `voice_alerts` | bool | Turns Sarvam TTS on/off |
| `presence_geofence` | bool | Off → code-only presence (handy indoors at the venue) |
| `eta_style` | multivariate `minutes` \| `people` | **A/B test:** "~15–20 min" vs "3 people ahead". Evaluated per identity (user id) |

- Bootstrap returns the resolved flags. For the A/B test, log `eta_style` + whether the guest stayed in the queue (not cancelled) and show the two cancel-rates in admin Overview.

### 14.3 NudgeBee — planner's ops autopilot with human approval
Varisai side (`server/src/routes/ops.ts`, Bearer `OPS_TOKEN`, 401 if unset):
- `GET /api/ops/overview` → `{ booths: [{id, name, event, waiting, estWaitMin, artists, paused}], alerts: [{boothId, reason}] }`. Alert when `estWaitMin > 25`.
- `POST /api/ops/booths/:id/artists {artists}` (1–5) → updates booth, recomputes ETAs, emits `booth:update`.
- Optional push: when a booth first crosses 25 min, ticker POSTs the alert to `NUDGEBEE_WEBHOOK_URL` (deduped per booth per 15 min).

NudgeBee workflow (built by hand on its canvas, screenshot in README):
`Schedule (2 min) or Webhook` → `HTTP request GET /api/ops/overview` → `Switch: alerts not empty` → `AI Summary` ("Mehendi table: 38 min, 9 waiting") → `Approval` ("Open a 2nd artist?") → `HTTP request POST /api/ops/booths/:id/artists` → `Send IM` to the planner.
Needs the deployed URL (or a tunnel) so NudgeBee can reach the API.

**Demo beat (add after step 3 of §12):** queue at Mehendi goes red → NudgeBee asks for approval → approve → artists 1→2 → every waiting guest's ETA halves live.

---

# Part B — `CLAUDE.md` (copy into the repo root)

```md
# Varisai
Wedding-venue queue app. Plan: SPEC-LITE.md (wins over SPEC.md). Product name is Varisai (not ShaadiQ).

## Rules
- Read ONLY the SPEC-LITE.md section named in the prompt. Do not read SPEC.md or whole directories.
- /server/src/engine is pure TS: no I/O, no Date.now(); `now` is a parameter.
- DB is Node's built-in `node:sqlite` (DatabaseSync), NOT better-sqlite3. All DB writes go through `tx()` from db/db.ts, top level only, never nested. Validate every request body with zod.
- Errors are { error: code, message }. Roles come from memberships, never the JWT.
- Web: Angular standalone + signals + Tailwind CSS variables. No new UI libraries.
- Keep replies short. Don't re-print files you edited. Don't add features not in SPEC-LITE.md.
- After each task: run the relevant Jest tests, report pass/fail in two lines.

## Commands
npm install · npm run dev · npm test -w server · npm run seed
```

---

# Part C — Stage prompts (paste one at a time, `/clear` between stages)

**S0**
> Read SPEC-LITE.md §1, §5, §9 only. Create the `/server` workspace: `schema.sql`, `db.ts` (`node:sqlite` DatabaseSync + the `tx()` wrapper from §5, runs schema), `seed.ts` per §9, and an Express `index.ts` with `/api/health`. Add root scripts `dev`, `seed`, `test`. Don't touch `/web`. Run the seed and print row counts.

**S1a**
> Read SPEC-LITE.md §6 sections "Live queue", "Booking rules", "ETA". Implement `engine/live.ts` and `engine/eta.ts` as pure functions with table-driven Jest tests covering every bullet in §10 for these two files. Run them and show only the summary line.

**S1b**
> Read SPEC-LITE.md §6 sections "Feast rounds", "Family Passes", "Presence". Implement `engine/batch.ts`, `engine/passes.ts`, `engine/presence.ts` plus Jest tests per §10. Run them and show only the summary line.

**S2**
> Read SPEC-LITE.md §2, §7. Implement auth (cookie JWT, OTP always 123456), `requireRole`, `/api/me`, and the guest + booth routes by calling the engine functions. Add the ~8 supertest cases from §10. Run `npm test -w server`.

**S3 (server part only)**
> Read SPEC-LITE.md §7 socket line and §6 Ticker. Add `socket.ts` and `ticker.ts`: emit `booth:update`, `ticket:update`, `ticket:called`, `event:status`, `code:rotate`; ticker per §6. Don't touch the web app.

**S5**
> Read SPEC-LITE.md §6 "Family Passes" and §7 Admin passes/quotas lines. Add the admin pass and quota routes and wire claim into the guest route. Add supertest cases: 41st bride pass rejected, revoked pass cannot be claimed. Run tests.

**S6**
> Read SPEC-LITE.md §7 Admin lines. Add admin routes: events (create/patch/live override), booths (create/patch/pin/handlers), overview KPIs, and `venue-code`. Role-guard them. Run tests.

**U1 (web core)**
> Read SPEC-LITE.md §1, §2, §3. In `/web`: `core/` api (fetch, `{error,message}` → thrown ApiError), auth (signal of `/api/me`), socket (socket.io-client, typed events), `theme.service` + `themes.ts`. Login (phone → OTP 123456), role guards, `/` redirects to `home`. Build with `ng build`.

**U2 (guest)**
> Read SPEC-LITE.md §3, §4, §8 "Guest". Build `/w`: splash, presence (geo then code fallback), `shared/venue-map`, event chips, booth sheet with party stepper, ticket tray (max 3), your-turn takeover (vibrate + confetti), live `booth:update`/`ticket:update`/`ticket:called`/`event:status`. `ng build`.

**U3 (handler)**
> Read SPEC-LITE.md §8 "Booth handler". Build `/booth` against `/api/booth/*` and `booth:update`. `ng build`.

**U4 (admin)**
> Read SPEC-LITE.md §4, §8 "Admin" (Overview, Events, Layout, Venue screen). Build `/admin` tabs and `/admin/venue` (QR via `qrcode`, 30-s ring, `code:rotate`). `ng build`.

**U5 (passes)**
> Read SPEC-LITE.md §6 "Family Passes", §8 "Admin → Passes". Build the Passes tab and `/p/:token` claim screen. `ng build`, then walk the §12 demo path against `npm run dev`.

**S6.5a (Sarvam)**
> Read SPEC-LITE.md §14 intro + §14.1. Look up the Sarvam translate + text-to-speech API reference first. Add `sponsors/sarvam.ts` and hook it after `ticket:called` commits; emit `ticket:voice`. Add the language picker field to the guest presence API. Keyless = no-op. Unit-test the cache + keyless path with a mocked fetch.

**S6.5b (Flagsmith)**
> Read SPEC-LITE.md §14 intro + §14.2. Add `flagsmith-nodejs`, `sponsors/flags.ts` with defaults, 15 s refresh, `flags:update` socket event, flags in guest bootstrap, `eta_style` per identity, and the A/B cancel-rate KPI. Keyless = defaults. Test the defaults path.

**S6.5c (NudgeBee)**
> Read SPEC-LITE.md §14 intro + §14.3. Add `routes/ops.ts` (Bearer OPS_TOKEN) and the deduped webhook push in the ticker. Supertest: 401 without token, artists update changes estWaitMin. Then print step-by-step NudgeBee canvas instructions for me.

**S7**
> Read SPEC-LITE.md §6 and §12 only. Write `server/scripts/simulate.ts`: seeded RNG, 400 guests over 2 h, baseline physical lines vs Varisai virtual queues using `engine/live.ts` and `engine/batch.ts`. Print a markdown table of avg standing minutes, p90 wait, total guest-hours standing.

**Debugging (any time)**
> Test `<name>` fails with: `<first 10 lines of error>`. Fix the root cause in `<file>`. Don't refactor. Re-run only that test.

**UI tips**
- `venue-map`: one `<svg viewBox="0 0 1000 700">`, `@for` over zones and booths, `(click)` on the svg turns client coords into `x_pct/y_pct`.
- `theme.service`: one `apply(key)` that writes CSS variables on `document.body`; `transition: background-color .4s, color .4s` on `body`.
- Takeover: a full-screen fixed div bound to a `called` signal, plus `navigator.vibrate` and `confetti()`.
