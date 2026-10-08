import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleApiError, GoogleAuthError, GoogleClient, isRetryable } from '../../src/google/google.client';

let fetchMock: ReturnType<typeof vi.fn>;
const client = new GoogleClient('CLIENT_ID', 'SECRETO_DE_GOOGLE', 'https://citara.test/connect/google/callback');
const ok = (json: unknown, status = 200) => ({ ok: status < 300, status, json: async () => json });
const idToken = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
const BODY = { summary: 'Corte — Ana', description: 'x',
  start: { dateTime: '2026-09-10T15:00:00.000Z', timeZone: 'America/Bogota' },
  end: { dateTime: '2026-09-10T15:30:00.000Z', timeZone: 'America/Bogota' } };

beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });

describe('GoogleClient: OAuth', () => {
  it('la URL de autorización pide acceso permanente, consentimiento y los cuatro permisos', () => {
    const u = new URL(client.authUrl('ESTADO'));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: 'CLIENT_ID', redirect_uri: 'https://citara.test/connect/google/callback', response_type: 'code',
      access_type: 'offline', prompt: 'consent', state: 'ESTADO' });
    expect(u.searchParams.get('scope')!.split(' ')).toEqual([
      'openid', 'email', 'https://www.googleapis.com/auth/calendar.app.created',
      'https://www.googleapis.com/auth/calendar.freebusy']);
    expect(u.toString()).not.toContain('SECRETO_DE_GOOGLE');
  });

  it('canjea el código: el secreto va en el cuerpo, y lee permisos y correo', async () => {
    fetchMock.mockResolvedValue(ok({ access_token: 'ya29.a', expires_in: 3599, refresh_token: '1//r',
      scope: 'openid https://www.googleapis.com/auth/calendar.freebusy', id_token: idToken({ email: 'maria@gmail.com' }) }));
    const r = await client.exchangeCode('CODIGO');
    expect(r).toEqual({ accessToken: 'ya29.a', expiresIn: 3599, refreshToken: '1//r',
      scopes: ['openid', 'https://www.googleapis.com/auth/calendar.freebusy'], email: 'maria@gmail.com' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(url).not.toContain('SECRETO');
    expect(Object.fromEntries(new URLSearchParams(init.body))).toMatchObject({
      code: 'CODIGO', client_secret: 'SECRETO_DE_GOOGLE', grant_type: 'authorization_code' });
  });

  it('invalid_grant al renovar es un GoogleAuthError: hay que reconectar', async () => {
    fetchMock.mockResolvedValue(ok({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400));
    await expect(client.refreshAccessToken('1//r')).rejects.toBeInstanceOf(GoogleAuthError);
  });

  it('un fallo de red no filtra el secreto', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed client_secret=SECRETO_DE_GOOGLE'));
    const err = await client.refreshAccessToken('1//r').catch((e) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.message).not.toContain('SECRETO_DE_GOOGLE');
    expect(isRetryable(err)).toBe(true);
  });
});

describe('GoogleClient: calendario', () => {
  it('crea el calendario "Citas" en la zona del negocio', async () => {
    fetchMock.mockResolvedValue(ok({ id: 'citas@group.calendar.google.com' }));
    expect(await client.createCalendar('ya29', 'Citas · María', 'America/Bogota')).toBe('citas@group.calendar.google.com');
    const [url, init] = fetchMock.mock.calls[0];
    expect([url, init.method, init.headers.Authorization]).toEqual(
      ['https://www.googleapis.com/calendar/v3/calendars', 'POST', 'Bearer ya29']);
    expect(JSON.parse(init.body)).toEqual({ summary: 'Citas · María', timeZone: 'America/Bogota' });
  });

  it('un calendario borrado no existe', async () => {
    fetchMock.mockResolvedValue(ok({ error: { code: 404, message: 'Not Found' } }, 404));
    expect(await client.calendarExists('ya29', 'c@group')).toBe(false);
    expect(fetchMock.mock.calls[0][0]).toBe('https://www.googleapis.com/calendar/v3/calendars/c%40group');
  });

  it('crear un evento con un id que ya existe es "exists", no un error', async () => {
    fetchMock.mockResolvedValue(ok({ error: { code: 409, message: 'The requested identifier already exists.' } }, 409));
    expect(await client.insertEvent('ya29', 'c@group', 'abc12', BODY)).toBe('exists');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/c%40group/events?sendUpdates=none');
    expect(JSON.parse(init.body)).toMatchObject({ id: 'abc12', summary: 'Corte — Ana' });
  });

  it('actualizar un evento lo deja confirmado (restaura uno borrado)', async () => {
    fetchMock.mockResolvedValue(ok({}));
    await client.patchEvent('ya29', 'c@group', 'abc12', BODY);
    const [url, init] = fetchMock.mock.calls[0];
    expect([url, init.method]).toEqual(
      ['https://www.googleapis.com/calendar/v3/calendars/c%40group/events/abc12?sendUpdates=none', 'PATCH']);
    expect(JSON.parse(init.body).status).toBe('confirmed');
  });

  it('borrar un evento que ya no está no es un error', async () => {
    fetchMock.mockResolvedValue(ok(null, 410));
    await expect(client.deleteEvent('ya29', 'c@group', 'abc12')).resolves.toBeUndefined();
  });

  it('lista con el syncToken y devuelve el siguiente', async () => {
    fetchMock.mockResolvedValue(ok({ items: [{ id: 'e1', status: 'cancelled' }], nextSyncToken: 'S2' }));
    const r = await client.listEvents('ya29', 'c@group', { syncToken: 'S1', pageToken: null });
    expect(r).toEqual({ items: [{ id: 'e1', status: 'cancelled' }], nextPageToken: null, nextSyncToken: 'S2' });
    const u = new URL(fetchMock.mock.calls[0][0]);
    expect(Object.fromEntries(u.searchParams)).toEqual({ maxResults: '2500', syncToken: 'S1' });
  });

  it('un syncToken vencido es un error 410 que no se reintenta a ciegas', async () => {
    fetchMock.mockResolvedValue(ok({ error: { code: 410, message: 'Sync token is no longer valid' } }, 410));
    const err = await client.listEvents('ya29', 'c', { syncToken: 'S1', pageToken: null }).catch((e) => e);
    expect([err.status, isRetryable(err)]).toEqual([410, false]);
  });

  it('el ocupado se pide en ventanas de 60 días y se junta', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ calendars: { primary: { busy: [{ start: '2026-09-10T15:00:00Z', end: '2026-09-10T16:00:00Z' }] } } }))
      .mockResolvedValueOnce(ok({ calendars: { primary: { busy: [{ start: '2026-11-20T15:00:00Z', end: '2026-11-20T16:00:00Z' }] } } }));
    const busy = await client.freeBusy('ya29', new Date('2026-09-08T00:00:00Z'), new Date('2026-12-01T00:00:00Z'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(busy.map((b) => b.start.toISOString())).toEqual(['2026-09-10T15:00:00.000Z', '2026-11-20T15:00:00.000Z']);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).items).toEqual([{ id: 'primary' }]);
  });

  it('un error de Google dentro de la respuesta de freeBusy es un error', async () => {
    fetchMock.mockResolvedValue(ok({ calendars: { primary: { errors: [{ domain: 'global', reason: 'internalError' }] } } }));
    await expect(client.freeBusy('ya29', new Date('2026-09-08T00:00:00Z'), new Date('2026-09-09T00:00:00Z')))
      .rejects.toBeInstanceOf(GoogleApiError);
  });

  it('abre un canal de watch y devuelve su expiración', async () => {
    fetchMock.mockResolvedValue(ok({ resourceId: 'RID', expiration: '1791000000000' }));
    const r = await client.watchEvents('ya29', 'c@group', { id: 'CH', token: 'T', address: 'https://citara.test/webhooks/google', ttlSeconds: 100 });
    expect(r).toEqual({ resourceId: 'RID', expiration: new Date(1791000000000) });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      id: 'CH', type: 'web_hook', address: 'https://citara.test/webhooks/google', token: 'T', params: { ttl: '100' } });
  });

  it('los límites de tasa y los 5xx se reintentan; un 400 no', () => {
    expect(isRetryable(new GoogleApiError('x', 503))).toBe(true);
    expect(isRetryable(new GoogleApiError('x', 429))).toBe(true);
    expect(isRetryable(new GoogleApiError('x', 403, 'rateLimitExceeded'))).toBe(true);
    expect(isRetryable(new GoogleApiError('x', 403, 'forbidden'))).toBe(false);
    expect(isRetryable(new GoogleApiError('x', 400))).toBe(false);
  });
});
