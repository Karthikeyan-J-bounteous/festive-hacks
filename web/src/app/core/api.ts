import { Injectable } from '@angular/core';

/** A failed API call. Mirrors the server's `{ error, message }`. */
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

@Injectable({ providedIn: 'root' })
export class Api {
  get<T>(url: string): Promise<T> {
    return this.request<T>('GET', url);
  }
  post<T>(url: string, body: unknown = {}): Promise<T> {
    return this.request<T>('POST', url, body);
  }
  put<T>(url: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', url, body);
  }
  patch<T>(url: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', url, body);
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, 'offline', 'Cannot reach the server, check your connection');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiError(res.status, data.error ?? 'error', data.message ?? 'Something went wrong');
    }
    return data as T;
  }
}

/** Message for any thrown value, for toasts. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}
