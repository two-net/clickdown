import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiErrorBody, RateLimit, Settings } from './models';

export type LoadError =
  | { kind: 'unauthorized'; message: string; configPath: string }
  | { kind: 'network' }
  | { kind: 'unreachable' } // the ClickDown server itself isn't answering
  | { kind: 'other'; message: string };

const DEFAULT_SETTINGS: Settings = { animations: true, only_lists: [] };
// The system's reduced-motion setting turns animations off too. (Test browsers have no matchMedia.)
const REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** The only door to the local server. It can only read. */
@Injectable({ providedIn: 'root' })
export class Backend {
  private readonly http = inject(HttpClient);
  readonly settings = signal<Settings>(DEFAULT_SETTINGS);
  /** Whether anything animates: config.toml allows it and the system doesn't ask for reduced motion. */
  readonly motion = computed(() => this.settings().animations && !REDUCED_MOTION);
  /** Seconds until rate-limited requests retry; 0 when not rate limited. Drives the countdowns. */
  readonly retryIn = signal(0);
  /** ClickUp's rate-limit numbers from the latest answer, when it sent them. */
  readonly rate = signal<RateLimit | null>(null);
  /** Requests still waiting for an answer; drives the status bar's spinner. */
  readonly inflight = signal(0);
  /** How the latest request went, for the status bar. */
  readonly connection = signal<'ok' | 'network' | 'unreachable'>('ok');
  private rateLimitedUntil = 0; // epoch ms, shared by every waiting request
  private rateLimitWait?: Promise<void>;

  async get<T>(path: string): Promise<T> {
    this.inflight.update((n) => n + 1);
    try {
      for (;;) {
        if (this.rateLimitWait) await this.rateLimitWait; // don't send while rate limited
        try {
          const response = await firstValueFrom(this.http.get<T>(path, { observe: 'response' }));
          this.noteRate(response.headers);
          this.connection.set('ok');
          return response.body as T;
        } catch (e) {
          if (e instanceof HttpErrorResponse) this.noteRate(e.headers);
          const body = errorBody(e);
          if (body?.error !== 'rate_limited') throw this.noteFailure(toLoadError(e, body));
          await this.waitOutRateLimit(body.retry_in_s);
        }
      }
    } finally {
      this.inflight.update((n) => n - 1);
    }
  }

  /** Never rejects: if the server is down or slow we keep the current settings (at boot, the defaults), so we can say so. */
  async loadSettings(): Promise<void> {
    const timeout = new Promise<Settings>((done) => setTimeout(() => done(this.settings()), 300));
    const settings = await Promise.race([this.get<Settings>('/api/settings'), timeout]).catch(() => this.settings());
    this.settings.set(settings);
    document.documentElement.classList.toggle('no-motion', !this.motion());
  }

  /** The server passes on ClickUp's latest numbers; without them there's nothing to show. */
  private noteRate(headers: HttpHeaders) {
    const limit = Number(headers.get('x-ratelimit-limit') ?? NaN);
    const remaining = Number(headers.get('x-ratelimit-remaining') ?? NaN);
    this.rate.set(Number.isFinite(limit) && Number.isFinite(remaining) ? { limit, remaining } : null);
  }

  private noteFailure(error: LoadError): LoadError {
    this.connection.set(error.kind === 'network' || error.kind === 'unreachable' ? error.kind : 'ok');
    return error;
  }

  /** All rate-limited requests share one deadline and one countdown, then retry together. */
  private waitOutRateLimit(seconds: number): Promise<void> {
    this.rateLimitedUntil = Math.max(this.rateLimitedUntil, Date.now() + seconds * 1000);
    return (this.rateLimitWait ??= this.countDown());
  }

  private async countDown(): Promise<void> {
    for (let left; (left = this.rateLimitedUntil - Date.now()) > 0; ) {
      this.retryIn.set(Math.ceil(left / 1000));
      await new Promise((tick) => setTimeout(tick, left % 1000 || 1000));
    }
    this.retryIn.set(0);
    this.rateLimitWait = undefined;
  }
}

function errorBody(e: unknown): ApiErrorBody | undefined {
  const body: unknown = e instanceof HttpErrorResponse ? e.error : undefined;
  return typeof body === 'object' && body !== null && 'error' in body ? (body as ApiErrorBody) : undefined;
}

function toLoadError(e: unknown, body: ApiErrorBody | undefined): LoadError {
  const status = e instanceof HttpErrorResponse ? e.status : -1;
  if (!body) {
    // Status 0 = nothing answered; a non-JSON 5xx = the dev proxy saying the server is down.
    if (status === 0 || status >= 500) return { kind: 'unreachable' };
    return { kind: 'other', message: e instanceof Error ? e.message : String(e) };
  }
  switch (body.error) {
    case 'unauthorized':
      return { kind: 'unauthorized', message: body.message, configPath: body.config_path };
    case 'network':
      return { kind: 'network' };
    case 'clickup':
    case 'not_allowed':
      return { kind: 'other', message: body.message };
    case 'not_found': // the UI only calls real routes, so only_lists switched this one off
      return { kind: 'other', message: 'This level is switched off by only_lists in config.toml.' };
    default:
      return { kind: 'other', message: `The server answered ${status} (${body.error}).` };
  }
}
