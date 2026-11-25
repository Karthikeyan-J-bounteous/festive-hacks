import { Injectable, computed, inject, signal } from '@angular/core';
import { Api, ApiError } from './api';
import { Me, Role } from './models';
import { Socket } from './socket';

/** Current user from `/api/me`. Roles come from memberships, as on the server. */
@Injectable({ providedIn: 'root' })
export class Auth {
  private readonly api = inject(Api);
  private readonly socket = inject(Socket);
  private loading: Promise<Me | null> | null = null;

  /** undefined = not loaded yet, null = logged out */
  readonly me = signal<Me | null | undefined>(undefined);
  readonly roles = computed(() => new Set(this.me()?.memberships.map((m) => m.role) ?? []));

  hasRole(...roles: Role[]): boolean {
    return roles.some((r) => this.roles().has(r));
  }

  /** Load once; later calls reuse the answer. */
  load(): Promise<Me | null> {
    this.loading ??= this.api.get<Me>('/api/me').then(
      (me) => {
        this.me.set(me);
        return me;
      },
      (e: unknown) => {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          this.me.set(null);
          return null;
        }
        this.loading = null; // offline: retry next time
        throw e;
      },
    );
    return this.loading;
  }

  requestOtp(phone: string): Promise<{ ok: true }> {
    return this.api.post('/api/auth/otp', { phone });
  }

  async verify(phone: string, otp: string): Promise<Me> {
    const me = await this.api.post<Me>('/api/auth/verify', { phone, otp });
    this.me.set(me);
    this.loading = Promise.resolve(me);
    this.socket.reconnect(); // rooms are joined at handshake, so pick up the new session
    return me;
  }
}
