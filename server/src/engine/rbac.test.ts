import { describe, expect, it } from 'vitest';
import { ACTIONS, ActionName, Role, authorize } from './rbac';

// Permission matrix (SPEC-LITE §2). Booth-scoped rows use booth 1 (assigned) / booth 2 (not assigned).
const ADMIN: Role[] = ['admin'];
const HANDLER: Role[] = ['booth_handler', 'guest'];
const GUEST: Role[] = ['guest'];

const matrix: [ActionName, number | undefined, boolean, boolean, boolean][] = [
  //  action          booth  admin  handler guest
  ['manageEvents',   undefined, true, false, false],
  ['manageLayout',   undefined, true, false, false],
  ['managePasses',   undefined, true, false, false],
  ['viewOverview',   undefined, true, false, false],
  ['operateBooth',   1,         true, true,  false],
  ['operateBooth',   2,         true, false, false],
  ['joinQueue',      undefined, true, true,  true],
];

describe('RBAC matrix', () => {
  it.each(matrix)('%s (booth %s): admin=%s handler=%s guest=%s', (action, boothId, admin, handler, guest) => {
    const scope = { boothId, handlerBoothIds: [1] };
    const as = (roles: Role[]) => authorize(roles.map((role) => ({ role })), ACTIONS[action], scope);
    expect(as(ADMIN)).toBe(admin);
    expect(as(HANDLER)).toBe(handler);
    expect(as(GUEST)).toBe(guest);
  });

  it('denies a user with no memberships', () => {
    expect(authorize([], ACTIONS.joinQueue)).toBe(false);
  });
});
