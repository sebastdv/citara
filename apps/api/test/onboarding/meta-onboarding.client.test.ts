import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetaOnboardingClient, MetaOnboardingError } from '../../src/onboarding/meta-onboarding.client';

let fetchMock: ReturnType<typeof vi.fn>;
const client = new MetaOnboardingClient('v25.0', 'APP_ID', 'SECRETO_DE_LA_APP');
const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json });

beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });

describe('MetaOnboardingClient', () => {
  it('canjea el código por el token del negocio', async () => {
    fetchMock.mockResolvedValue(ok({ access_token: 'EAAG-negocio' }));
    expect(await client.exchangeCode('CODIGO')).toBe('EAAG-negocio');
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/v25.0/oauth/access_token');
    expect(Object.fromEntries(url.searchParams)).toEqual(
      { client_id: 'APP_ID', client_secret: 'SECRETO_DE_LA_APP', code: 'CODIGO' });
  });

  it('lista los números de la cuenta', async () => {
    fetchMock.mockResolvedValue(ok({ data: [{ id: '106999', display_phone_number: '+57 300 000 0000' }] }));
    expect(await client.phoneNumbers('777', 'EAAG')).toEqual([{ id: '106999', displayPhoneNumber: '+57 300 000 0000' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url).pathname).toBe('/v25.0/777/phone_numbers');
    expect(init.headers.Authorization).toBe('Bearer EAAG');
  });

  it('suscribe la app a los webhooks de la cuenta', async () => {
    fetchMock.mockResolvedValue(ok({ success: true }));
    await client.subscribeApp('777', 'EAAG');
    const [url, init] = fetchMock.mock.calls[0];
    expect([new URL(url).pathname, init.method]).toEqual(['/v25.0/777/subscribed_apps', 'POST']);
  });

  it('pide la sincronización con el cuerpo que espera Meta', async () => {
    fetchMock.mockResolvedValue(ok({ success: true }));
    await client.requestSync('106999', 'EAAG', 'history');
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url).pathname).toBe('/v25.0/106999/smb_app_data');
    expect(JSON.parse(init.body)).toEqual({ messaging_product: 'whatsapp', sync_type: 'history' });
  });

  it('un rechazo de Meta es un error legible que nunca incluye el secreto', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid verification code' } }) });
    const err = await client.exchangeCode('MALO').catch((e) => e);
    expect(err).toBeInstanceOf(MetaOnboardingError);
    expect(err.message).toMatch(/Invalid verification code/);
    expect(err.message).not.toContain('SECRETO_DE_LA_APP');
  });

  it('un fallo de red tampoco filtra el secreto', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed https://graph.facebook.com/?client_secret=SECRETO_DE_LA_APP'));
    const err = await client.exchangeCode('X').catch((e) => e);
    expect(err.message).not.toContain('SECRETO_DE_LA_APP');
  });

  it('un 200 sin token es un error, no un token vacío', async () => {
    fetchMock.mockResolvedValue(ok({}));
    await expect(client.exchangeCode('X')).rejects.toBeInstanceOf(MetaOnboardingError);
  });
});
