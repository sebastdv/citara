import type { BusyInterval } from '../scheduling/availability';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  // Solo los calendarios que crea la app: ahí van las citas.
  'https://www.googleapis.com/auth/calendar.app.created',
  // Cuándo está ocupada la persona en su calendario principal, sin leer sus eventos.
  'https://www.googleapis.com/auth/calendar.freebusy',
] as const;
/** El consentimiento granular de Google permite desmarcarlos; sin ellos no hay integración. */
export const REQUIRED_CALENDAR_SCOPES: readonly string[] = GOOGLE_SCOPES.slice(2);

/** Una llamada a Google que no salió. El mensaje es apto para logs: sin tokens ni secreto. */
export class GoogleApiError extends Error {
  constructor(message: string, readonly status: number | null, readonly reason: string | null = null) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

/** El refresh token ya no sirve (revocado, o vencido en modo testing): hay que reconectar. */
export class GoogleAuthError extends GoogleApiError {
  constructor(message: string) {
    super(message, 400, 'invalid_grant');
    this.name = 'GoogleAuthError';
  }
}

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);

/** Red caída, límites de tasa y 5xx: el siguiente intento puede salir. */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof GoogleApiError) || err instanceof GoogleAuthError) return false;
  if (err.status === null || err.status === 429 || err.status >= 500) return true;
  return err.status === 403 && RATE_LIMIT_REASONS.has(err.reason ?? '');
}

export interface GoogleEvent {
  id: string; status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

export interface EventBody {
  summary: string; description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  extendedProperties?: { private: Record<string, string> };
}

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const TIMEOUT_MS = 10_000;
/** VERIFICAR: freeBusy rechaza rangos largos (~3 meses). Se pide por ventanas. */
const FREEBUSY_WINDOW_MS = 60 * 86_400_000;

type Json = Record<string, any> | null;

/**
 * OAuth y la Calendar API v3 con fetch (sin la librería googleapis). Es el
 * único lugar que conoce estos endpoints. Ninguna URL lleva secretos: el
 * client secret y los refresh tokens viajan en el cuerpo.
 */
export class GoogleClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {}

  authUrl(state: string): string {
    const u = new URL(AUTH_URL);
    u.search = new URLSearchParams({
      client_id: this.clientId, redirect_uri: this.redirectUri, response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      // offline + consent: sin ellos Google no entrega refresh token al reconectar.
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state,
    }).toString();
    return u.toString();
  }

  async exchangeCode(code: string) {
    const json = await this.token('canje del código',
      { code, grant_type: 'authorization_code', redirect_uri: this.redirectUri });
    return {
      accessToken: String(json.access_token), expiresIn: Number(json.expires_in ?? 3600),
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
      scopes: typeof json.scope === 'string' ? json.scope.split(' ') : [],
      email: emailFromIdToken(json.id_token),
    };
  }

  async refreshAccessToken(refreshToken: string) {
    const json = await this.token('renovación del token', { refresh_token: refreshToken, grant_type: 'refresh_token' });
    return { accessToken: String(json.access_token), expiresIn: Number(json.expires_in ?? 3600) };
  }

  async createCalendar(token: string, summary: string, timeZone: string): Promise<string> {
    const { json } = await this.api('creación del calendario', token, 'POST', '/calendars', { body: { summary, timeZone } });
    if (typeof json?.id !== 'string') throw new GoogleApiError('creación del calendario: Google no devolvió id', 200);
    return json.id;
  }

  async calendarExists(token: string, calendarId: string): Promise<boolean> {
    const { status } = await this.api('consulta del calendario', token, 'GET', `/calendars/${enc(calendarId)}`,
      { accept: [404, 410] });
    return status < 300;
  }

  async freeBusy(token: string, from: Date, to: Date, timeoutMs = TIMEOUT_MS): Promise<BusyInterval[]> {
    const out: BusyInterval[] = [];
    for (let start = from.getTime(); start < to.getTime(); start += FREEBUSY_WINDOW_MS) {
      const end = Math.min(start + FREEBUSY_WINDOW_MS, to.getTime());
      const { json } = await this.api('consulta de ocupado', token, 'POST', '/freeBusy', {
        body: { timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), items: [{ id: 'primary' }] },
        timeoutMs,
      });
      const cal = json?.calendars?.primary;
      if (cal?.errors?.length) {
        throw new GoogleApiError(`consulta de ocupado: ${cal.errors[0].reason ?? 'error'}`, 200, cal.errors[0].reason ?? null);
      }
      for (const b of cal?.busy ?? []) out.push({ start: new Date(b.start), end: new Date(b.end) });
    }
    return out;
  }

  async insertEvent(token: string, calendarId: string, eventId: string, body: EventBody): Promise<'created' | 'exists'> {
    const { status } = await this.api('creación del evento', token, 'POST',
      `/calendars/${enc(calendarId)}/events?sendUpdates=none`, { body: { id: eventId, ...body }, accept: [409] });
    return status === 409 ? 'exists' : 'created';
  }

  async patchEvent(token: string, calendarId: string, eventId: string, body: EventBody): Promise<void> {
    // status 'confirmed' devuelve a la vida un evento que el dueño había borrado (VERIFICAR).
    await this.api('actualización del evento', token, 'PATCH',
      `/calendars/${enc(calendarId)}/events/${enc(eventId)}?sendUpdates=none`, { body: { ...body, status: 'confirmed' } });
  }

  async deleteEvent(token: string, calendarId: string, eventId: string): Promise<void> {
    await this.api('borrado del evento', token, 'DELETE',
      `/calendars/${enc(calendarId)}/events/${enc(eventId)}?sendUpdates=none`, { accept: [404, 410] });
  }

  async listEvents(token: string, calendarId: string, q: { syncToken: string | null; pageToken: string | null }) {
    const params = new URLSearchParams({ maxResults: '2500' });
    if (q.syncToken) params.set('syncToken', q.syncToken);
    if (q.pageToken) params.set('pageToken', q.pageToken);
    const { json } = await this.api('lectura de cambios', token, 'GET', `/calendars/${enc(calendarId)}/events?${params}`);
    return {
      items: (json?.items ?? []) as GoogleEvent[],
      nextPageToken: (json?.nextPageToken as string | undefined) ?? null,
      nextSyncToken: (json?.nextSyncToken as string | undefined) ?? null,
    };
  }

  async watchEvents(token: string, calendarId: string, ch: { id: string; token: string; address: string; ttlSeconds: number }) {
    const { json } = await this.api('apertura del canal de avisos', token, 'POST', `/calendars/${enc(calendarId)}/events/watch`, {
      body: { id: ch.id, type: 'web_hook', address: ch.address, token: ch.token, params: { ttl: String(ch.ttlSeconds) } },
    });
    return { resourceId: String(json?.resourceId), expiration: new Date(Number(json?.expiration)) };
  }

  async stopChannel(token: string, channelId: string, resourceId: string): Promise<void> {
    await this.api('cierre del canal de avisos', token, 'POST', '/channels/stop',
      { body: { id: channelId, resourceId }, accept: [404] });
  }

  private async token(what: string, params: Record<string, string>): Promise<Record<string, any>> {
    let res: Response;
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...params }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new GoogleApiError(`${what}: fallo de red (${(err as Error).name})`, null);
    }
    const json: Json = await res.json().catch(() => null);
    if (!res.ok) {
      if (json?.error === 'invalid_grant') throw new GoogleAuthError(`${what}: Google respondió invalid_grant`);
      const detail = typeof json?.error === 'string' ? ` — ${json.error}` : '';
      throw new GoogleApiError(`${what}: Google respondió ${res.status}${detail}`, res.status,
        typeof json?.error === 'string' ? json.error : null);
    }
    if (typeof json?.access_token !== 'string') throw new GoogleApiError(`${what}: Google no devolvió token`, res.status);
    return json;
  }

  private async api(
    what: string, token: string, method: string, path: string,
    opts: { body?: unknown; accept?: number[]; timeoutMs?: number } = {},
  ): Promise<{ status: number; json: Json }> {
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (err) {
      throw new GoogleApiError(`${what}: fallo de red (${(err as Error).name})`, null);
    }
    const json: Json = res.status === 204 ? null : await res.json().catch(() => null);
    if (res.ok || opts.accept?.includes(res.status)) return { status: res.status, json };
    const reason = json?.error?.errors?.[0]?.reason ?? null;
    const detail = typeof json?.error?.message === 'string' ? ` — ${json.error.message}` : '';
    throw new GoogleApiError(`${what}: Google respondió ${res.status}${detail}`, res.status, reason);
  }
}

const enc = (s: string) => encodeURIComponent(s);

/** El correo de la cuenta, del id_token que Google entrega en el canje (por TLS, directo de Google). */
function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}
