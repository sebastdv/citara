import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetaSender } from '../../src/whatsapp/sender';

const channel = { tenantId: 't', channelId: 'c', wabaId: 'w',
                  phoneNumberId: '106540', accessToken: 'TOKEN' };
let fetchMock: ReturnType<typeof vi.fn>;
let sender: MetaSender;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ messages: [{ id: 'wamid.OUT1' }] }),
  });
  vi.stubGlobal('fetch', fetchMock);
  sender = new MetaSender('v21.0');
});

describe('MetaSender', () => {
  it('envía texto al endpoint correcto con el token del canal', async () => {
    const res = await sender.send(channel, '573001112233', { kind: 'text', body: 'Hola' });

    expect(res.wamid).toBe('wamid.OUT1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v21.0/106540/messages');
    expect(init.headers.Authorization).toBe('Bearer TOKEN');
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '573001112233',
      type: 'text',
      text: { body: 'Hola', preview_url: false },
    });
  });

  it('arma el objeto interactive de botones', async () => {
    await sender.send(channel, '573001112233', {
      kind: 'buttons', body: '¿En qué te ayudo?',
      buttons: [{ id: 'agendar', title: 'Agendar cita' }],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.type).toBe('interactive');
    expect(body.interactive.type).toBe('button');
    expect(body.interactive.action.buttons).toEqual([
      { type: 'reply', reply: { id: 'agendar', title: 'Agendar cita' } },
    ]);
  });

  it('cae a texto numerado cuando hay más de 3 botones', async () => {
    await sender.send(channel, '573001112233', {
      kind: 'buttons', body: 'Elige',
      buttons: [1, 2, 3, 4].map((n) => ({ id: `o${n}`, title: `Opción ${n}` })),
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.type).toBe('text');
    expect(body.text.body).toContain('1. Opción 1');
    expect(body.text.body).toContain('4. Opción 4');
  });

  it('trunca los títulos de botón a los 20 caracteres que admite Meta', async () => {
    await sender.send(channel, '573001112233', {
      kind: 'buttons', body: 'x',
      buttons: [{ id: 'a', title: 'Un título larguísimo que no cabe' }],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.interactive.action.buttons[0].reply.title).toHaveLength(20);
  });

  it('lanza un error legible cuando Meta responde con fallo', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 400,
      json: async () => ({ error: { message: 'Invalid parameter', code: 100 } }),
    });
    await expect(sender.send(channel, '573001112233', { kind: 'text', body: 'x' }))
      .rejects.toThrow(/Invalid parameter/);
  });

  it('nunca incluye el token en el mensaje de error', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 401, json: async () => ({ error: { message: 'bad token' } }),
    });
    // `toThrow` no acepta matchers asimétricos: se captura y se afirma sobre el mensaje.
    const err = await sender.send(channel, '573001112233', { kind: 'text', body: 'x' })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('TOKEN');
  });
});
