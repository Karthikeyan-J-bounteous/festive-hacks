// Flagsmith (SPEC-LITE §14.2): live kill-switches + the `eta_style` A/B test.
// Keyless-safe: with no FLAGSMITH_ENVIRONMENT_KEY every flag is its default (all on, eta_style "minutes")
// and nothing touches the network. Every Flagsmith call has a 3 s cap and never throws.
// SDK checked 2026-11-25 (flagsmith-nodejs 8.1.2): a `ser.` key enables local evaluation (identity
// flags computed in-process from the environment document); any other key uses remote evaluation.
import { DefaultFlag, Flagsmith } from 'flagsmith-nodejs';

export type EtaStyle = 'minutes' | 'people';
export interface Flags {
  family_passes: boolean;
  feast_rounds: boolean;
  voice_alerts: boolean;
  presence_geofence: boolean;
  eta_style: EtaStyle;
}
export type BoolFlag = Exclude<keyof Flags, 'eta_style'>;

export const DEFAULT_FLAGS: Readonly<Flags> = Object.freeze({
  family_passes: true, feast_rounds: true, voice_alerts: true, presence_geofence: true, eta_style: 'minutes',
});
const BOOL_FLAGS: readonly BoolFlag[] = ['family_passes', 'feast_rounds', 'voice_alerts', 'presence_geofence'];

export const REFRESH_MS = 15_000;
const TIMEOUT_MS = 3_000;
const MAX_USERS = 5_000;

const key = (): string => process.env.FLAGSMITH_ENVIRONMENT_KEY ?? '';
export const flagsmithEnabled = (): boolean => key().length > 0;

let client: Flagsmith | null = null;
let env: Flags = { ...DEFAULT_FLAGS };       // environment-level values (the kill-switches)
const etaByUser = new Map<number, EtaStyle>(); // resolved A/B variant per identity

function getClient(): Flagsmith | null {
  if (!flagsmithEnabled()) return null;
  client ??= new Flagsmith({
    environmentKey: key(),
    enableLocalEvaluation: key().startsWith('ser.'),
    environmentRefreshIntervalSeconds: REFRESH_MS / 1000,
    requestTimeoutSeconds: TIMEOUT_MS / 1000,
    retries: 0,
    // A flag missing from the dashboard falls back to our default instead of throwing.
    defaultFlagHandler: (k) => k === 'eta_style'
      ? new DefaultFlag(DEFAULT_FLAGS.eta_style, true)
      : new DefaultFlag(null, (DEFAULT_FLAGS as unknown as Record<string, unknown>)[k] !== false),
  });
  return client;
}

/** Minimal view of the SDK's Flags object, so resolution is testable without the network. */
export interface FlagSource {
  isFeatureEnabled(name: string): boolean;
  getFeatureValue(name: string): unknown;
}

/** SDK flags → our shape. eta_style is "people" only when enabled with that value; anything else is control. */
export function resolveFlags(src: FlagSource): Flags {
  const out = { ...DEFAULT_FLAGS };
  for (const f of BOOL_FLAGS) out[f] = src.isFeatureEnabled(f);
  out.eta_style = src.isFeatureEnabled('eta_style') && src.getFeatureValue('eta_style') === 'people' ? 'people' : 'minutes';
  return out;
}

function capped<T>(p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS).unref())]);
}

const identity = (userId: number): string => String(userId);

async function fetchEnv(): Promise<Flags | null> {
  const c = getClient();
  if (!c) return null;
  try {
    return resolveFlags(await capped(c.getEnvironmentFlags()));
  } catch (e) {
    console.warn('[flagsmith] environment flags failed:', (e as Error).message);
    return null;
  }
}

async function fetchEtaStyle(userId: number): Promise<EtaStyle | null> {
  const c = getClient();
  if (!c) return null;
  try {
    return resolveFlags(await capped(c.getIdentityFlags(identity(userId)))).eta_style;
  } catch (e) {
    console.warn('[flagsmith] identity flags failed:', (e as Error).message);
    return null;
  }
}

function remember(userId: number, style: EtaStyle): void {
  etaByUser.delete(userId);
  if (etaByUser.size >= MAX_USERS) etaByUser.delete(etaByUser.keys().next().value!);
  etaByUser.set(userId, style);
}

/** Current kill-switch value. Synchronous: safe inside tx(). */
export const flag = (name: BoolFlag): boolean => env[name];

/** This user's A/B variant if already resolved, else the environment value. Synchronous: safe inside tx(). */
export const etaStyleOf = (userId: number): EtaStyle => etaByUser.get(userId) ?? env.eta_style;

/** Flags as one user sees them (kill-switches + their eta_style variant), from cache. */
export const flagsOf = (userId: number): Flags => ({ ...env, eta_style: etaStyleOf(userId) });

/** Resolve (and cache) this user's flags. Never throws; at most ~3 s on a cold remote lookup. */
export async function flagsFor(userId: number): Promise<Flags> {
  if (flagsmithEnabled() && !etaByUser.has(userId)) {
    const style = await fetchEtaStyle(userId);
    if (style) remember(userId, style);
  }
  return flagsOf(userId);
}

export interface FlagsChange {
  before: Flags;
  after: Flags;
  /** users whose eta_style variant changed */
  users: number[];
}

/** Refetch environment flags and the given users' variants. Returns what changed, or null. */
export async function refreshFlags(userIds: readonly number[]): Promise<FlagsChange | null> {
  if (!flagsmithEnabled()) return null;
  const next = await fetchEnv();
  const before = env;
  if (next) env = next;
  const users: number[] = [];
  await Promise.all(userIds.map(async (id) => {
    const style = await fetchEtaStyle(id);
    if (!style) return;
    const prev = etaByUser.get(id);
    remember(id, style);
    if (prev !== undefined && prev !== style) users.push(id);
  }));
  const envChanged = (Object.keys(env) as (keyof Flags)[]).some((k) => env[k] !== before[k]);
  return envChanged || users.length ? { before, after: env, users } : null;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Every 15 s: refresh, and report changes. No-op without a key. */
export function startFlags(connectedUsers: () => number[], onChange: (c: FlagsChange) => void): void {
  if (!flagsmithEnabled() || timer) return;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const change = await refreshFlags(connectedUsers());
      if (change) onChange(change);
    } finally {
      running = false;
    }
  };
  void run();
  timer = setInterval(() => void run(), REFRESH_MS);
  timer.unref();
}

export async function stopFlags(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await client?.close();
  client = null;
}

/** Test hook: force flag values (merged over defaults) and forget cached variants. */
export function setFlagsForTest(patch: Partial<Flags> = {}): void {
  env = { ...DEFAULT_FLAGS, ...patch };
  etaByUser.clear();
}
