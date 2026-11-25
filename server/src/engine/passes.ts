// Family Passes (SPEC-LITE §6 "Family Passes"). Pure apart from crypto randomness for tokens.
import { randomBytes } from 'node:crypto';
import { EngineError } from './types';

export type Side = 'bride' | 'groom';

export interface Pass {
  id: number;
  side: Side;
  claimed_by_user_id: number | null;
  revoked_at: number | null;
}
export interface PassEvent {
  pass_id: number;
  event_id: number;
}

export class QuotaExceeded extends EngineError {
  constructor(public readonly eventId: number, public readonly used: number, public readonly limit: number) {
    super('quota_exceeded', `Quota full for event ${eventId} (${used}/${limit})`);
  }
}

/** 128-bit unguessable token, URL-safe. */
export function generateToken(): string {
  return randomBytes(16).toString('base64url');
}

/** Passes used per event for one side. Revoked passes don't count, so revoking frees quota. */
export function usedByEvent(passes: readonly Pass[], passEvents: readonly PassEvent[], side: Side): Map<number, number> {
  const live = new Set(passes.filter((p) => p.side === side && p.revoked_at === null).map((p) => p.id));
  const used = new Map<number, number>();
  for (const pe of passEvents) {
    if (live.has(pe.pass_id)) used.set(pe.event_id, (used.get(pe.event_id) ?? 0) + 1);
  }
  return used;
}

/**
 * All-or-nothing quota check for a new pass covering `eventIds`.
 * Missing limit = 0. Throws QuotaExceeded naming the first full event.
 */
export function assertQuota(eventIds: readonly number[], used: ReadonlyMap<number, number>, limits: ReadonlyMap<number, number>): void {
  if (eventIds.length === 0) throw new EngineError('no_events', 'A pass must cover at least one event');
  for (const eventId of eventIds) {
    const u = used.get(eventId) ?? 0;
    const limit = limits.get(eventId) ?? 0;
    if (u + 1 > limit) throw new QuotaExceeded(eventId, u, limit);
  }
}

export type ClaimOutcome = 'claim' | 'already_mine';

/**
 * Preconditions for claiming. The route must still run
 * `UPDATE ... WHERE id = ? AND claimed_by_user_id IS NULL` and treat 0 changes as 'already_claimed'.
 */
export function checkClaim(pass: Pass | undefined, userId: number, userHasOtherPass: boolean): ClaimOutcome {
  if (!pass || pass.revoked_at !== null) throw new EngineError('pass_invalid', 'This pass is no longer valid');
  if (pass.claimed_by_user_id === userId) return 'already_mine';
  if (pass.claimed_by_user_id !== null) throw new EngineError('already_claimed', 'This pass was already claimed');
  if (userHasOtherPass) throw new EngineError('already_have_pass', 'You already have a family pass');
  return 'claim';
}

/** A claimed, unrevoked pass held by `userId` that covers `eventId`. */
export function isFamilyFor(userId: number, eventId: number, passes: readonly Pass[], passEvents: readonly PassEvent[]): boolean {
  const mine = new Set(passes.filter((p) => p.claimed_by_user_id === userId && p.revoked_at === null).map((p) => p.id));
  return passEvents.some((pe) => pe.event_id === eventId && mine.has(pe.pass_id));
}
