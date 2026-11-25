// Shapes returned by the server (SPEC-LITE §7). Keep in sync with server/src/routes/*.

export type Role = 'admin' | 'booth_handler' | 'guest';
export type Side = 'bride' | 'groom';
export type TicketStatus = 'waiting' | 'away' | 'called' | 'serving' | 'done' | 'no_show' | 'cancelled';
export type WaitColour = 'green' | 'amber' | 'red' | 'grey';

export interface Me {
  user: { id: number; phone: string; name: string | null; lang: string };
  memberships: { weddingId: number; role: Role; side: Side | null }[];
  home: string;
}

export interface Eta { position: number; ahead: number; minutes: number; low: number; high: number }

export interface Ticket {
  id: number;
  boothId: number;
  boothName: string;
  eventId: number;
  code: string;
  option: string;
  partySize: number;
  status: TicketStatus;
  isVip: boolean;
  skipCount: number;
  roundId: number | null;
  joinedAt: number;
  calledAt: number | null;
  servingAt: number | null;
  eta: Eta | null;
}

export interface BoothOption { label: string; minutes: number }

export interface Booth {
  id: number;
  eventId: number;
  name: string;
  serviceType: string;
  mode: 'live' | 'batch';
  x: number;
  y: number;
  options: BoothOption[];
  artists: number;
  paused: boolean;
  roundSeats: number | null;
  roundMinutes: number | null;
  waiting: number;
  inProgress: number;
  waitMin: number;
  colour: WaitColour;
}

export interface QueueEntry extends Ticket { guestName: string | null }

export interface BoothState extends Booth {
  speedFactor: number;
  round: { id: number; roundNo: number; startedAt: number; endsAt: number; seatsUsed: number } | null;
  queue: QueueEntry[];
}

export interface AdminBooth extends Booth {
  codePrefix: string;
  speedFactor: number;
  handlers: { userId: number; name: string | null; phone: string }[];
}

export interface WeddingEvent {
  id: number;
  type: string;
  theme?: string;
  name: string;
  startsAt: number;
  endsAt: number;
}

export interface AdminEvent extends WeddingEvent {
  sortOrder: number;
  override: 'auto' | 'live' | 'ended';
  live: boolean;
  ended: boolean;
}

export interface MyPass { id: number; side: Side; label: string; eventIds: number[] }

/** Flagsmith (§14.2): kill-switches + this guest's eta_style A/B variant. */
export interface Flags {
  family_passes: boolean;
  feast_rounds: boolean;
  voice_alerts: boolean;
  presence_geofence: boolean;
  eta_style: 'minutes' | 'people';
}

export interface Bootstrap {
  wedding: { id: number; name: string; couple_names: string };
  events: WeddingEvent[];
  booths: Booth[];
  tickets: Ticket[];
  pass: MyPass | null;
  presence: { valid: boolean; validUntil: number | null };
  /** Sarvam (§14.1): the guest's language, and whether voice alerts are available. */
  lang: string;
  voice: boolean;
  flags: Flags;
}

export interface PublicWedding {
  name: string;
  coupleNames: string;
  liveEvent: { type: string; name: string } | null;
}
