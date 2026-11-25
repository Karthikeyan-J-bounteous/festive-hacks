// Role checks (SPEC-LITE §2). Roles come from memberships, never the JWT. Pure.

export type Role = 'admin' | 'booth_handler' | 'guest';

export interface MembershipLike {
  role: Role;
}

/** Who may do what. Routes call `authorize(memberships, ACTIONS.x, scope)`. */
export const ACTIONS = {
  manageEvents: ['admin'],
  manageLayout: ['admin'],
  managePasses: ['admin'],
  viewOverview: ['admin'],
  operateBooth: ['admin', 'booth_handler'],
  joinQueue: ['admin', 'booth_handler', 'guest'],
} as const satisfies Record<string, readonly Role[]>;

export type ActionName = keyof typeof ACTIONS;

export interface Scope {
  /** the booth being operated, for booth-scoped actions */
  boothId?: number;
  /** booths this user is assigned to as a handler */
  handlerBoothIds?: readonly number[];
}

/**
 * Admin passes any scope. A booth handler passes a booth-scoped check only for assigned booths.
 * Any membership with an allowed role passes otherwise.
 */
export function authorize(memberships: readonly MembershipLike[], allowed: readonly Role[], scope: Scope = {}): boolean {
  return memberships.some((m) => {
    if (!allowed.includes(m.role)) return false;
    if (m.role === 'booth_handler' && scope.boothId !== undefined) {
      return scope.handlerBoothIds?.includes(scope.boothId) ?? false;
    }
    return true;
  });
}
