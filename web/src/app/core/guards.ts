import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Auth } from './auth';
import { Role } from './models';

/** Logged in with one of `roles`; otherwise login (keeping the target) or the user's own home. */
export function roleGuard(...roles: Role[]): CanActivateFn {
  return async (_route, state) => {
    const auth = inject(Auth);
    const router = inject(Router);
    const me = await auth.load();
    if (!me) return router.createUrlTree(['/login'], { queryParams: { next: state.url } });
    return auth.hasRole(...roles) ? true : router.parseUrl(me.home);
  };
}

/** `/` → the user's home (admin → /admin, handler → /booth, guest → /w). */
export const homeRedirect: CanActivateFn = async () => {
  const router = inject(Router);
  const me = await inject(Auth).load();
  return router.parseUrl(me ? me.home : '/login');
};
