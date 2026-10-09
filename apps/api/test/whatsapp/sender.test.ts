import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetaSender, MetaSendError } from '../../src/whatsapp/sender';

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

  // Cuatro desenlaces de un rechazo, porque cada uno pide algo distinto:
  // permanent (no reintentar), retry (reintentar, Meta NO lo aceptó), window
  // (fuera de las 24 h) y ambiguous (pudo haber salido: no reenviar a ciegas).
  const rejectWith = (status: number, code?: number) =>
    fetchMock.mockResolvedValue({ ok: false, status,
      json: async () => (code ? { error: { message: 'x', code } } : {}) });
  const kindOf = async () =>
    (await sender.send(channel, '573001112233', { kind: 'text', body: 'Hola' })
      .catch((e) => e)) as MetaSendError;

  it('marca un 4xx como permanente: reintentarlo solo repite el rechazo', async () => {
    rejectWith(400, 100);
    const err = await kindOf();
    expect(err).toBeInstanceOf(MetaSendError);
    expect(err.kind).toBe('permanent');
    expect(err.status).toBe(400);
  });

  it('marca 429 y 5xx como reintentables', async () => {
    for (const status of [429, 500, 503]) {
      rejectWith(status);
      expect((await kindOf()).kind).toBe('retry');
    }
  });

  it('clasifica por código de Meta: los límites de tasa llegan con 400 y son reintentables', async () => {
    for (const code of [4, 80007, 130429, 131056]) {
      rejectWith(400, code);
      expect((await kindOf()).kind).toBe('retry');
    }
  });

  it('reconoce el rechazo por ventana de 24 h cerrada', async () => {
    rejectWith(400, 131047);
    expect((await kindOf()).kind).toBe('window');
  });

  it('un timeout es ambiguo: Meta pudo haberlo aceptado', async () => {
    fetchMock.mockRejectedValue(new DOMException('timeout', 'TimeoutError'));
    expect((await kindOf()).kind).toBe('ambiguous');
  });

  it('una conexión que ni se abrió es reintentable: seguro que no salió', async () => {
    fetchMock.mockRejectedValue(
      new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }));
    expect((await kindOf()).kind).toBe('retry');
  });

  it('un 200 sin wamid es ambiguo, no un éxito ni un rechazo', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    expect((await kindOf()).kind).toBe('ambiguous');
  });

  it('acota la espera: un Graph colgado no retiene el slot del worker', async () => {
    await sender.send(channel, '573001112233', { kind: 'text', body: 'Hola' });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('arma una plantilla con sus parámetros de cuerpo', async () => {
    await sender.send(channel, '573001112233', {
      kind: 'template', name: 'recordatorio_cita_24h', language: 'es', params: ['Ana', 'jueves 10:00', 'Corte'] });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '573001112233',
      type: 'template',
      template: { name: 'recordatorio_cita_24h', language: { code: 'es' },
        components: [{ type: 'body', parameters: [
          { type: 'text', text: 'Ana' }, { type: 'text', text: 'jueves 10:00' }, { type: 'text', text: 'Corte' }] }] },
    });
  });
});

describe('MetaSender.markTyping', () => {
  it('marca el mensaje como leído con el indicador de escritura', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    vi.stubGlobal('fetch', fetchMock);
    await new MetaSender('v25.0').markTyping(
      { tenantId: 't', channelId: 'c', wabaId: 'w', phoneNumberId: '106540', accessToken: 'EAAG' }, 'wamid.IN');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v25.0/106540/messages');
    expect(JSON.parse(init.body)).toEqual({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.IN',
                                            typing_indicator: { type: 'text' } });
  });
});
