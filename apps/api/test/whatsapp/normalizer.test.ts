import { describe, it, expect } from 'vitest';
import { normalizeWebhook } from '../../src/whatsapp/normalizer';

const envelope = (value: unknown) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '102290129340398', changes: [{ field: 'messages', value }] }],
});

const metadata = {
  messaging_product: 'whatsapp',
  metadata: { display_phone_number: '15550001', phone_number_id: '106540352242922' },
  contacts: [{ profile: { name: 'Ana' }, wa_id: '573001112233' }],
};

describe('normalizeWebhook', () => {
  it('normaliza un mensaje de texto', () => {
    const { messages } = normalizeWebhook(envelope({
      ...metadata,
      messages: [{
        from: '573001112233', id: 'wamid.ABC', timestamp: '1756900000',
        type: 'text', text: { body: 'Hola' },
      }],
    }));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      wamid: 'wamid.ABC',
      phoneNumberId: '106540352242922',
      wabaId: '102290129340398',
      from: '573001112233',
      profileName: 'Ana',
      type: 'text',
      text: 'Hola',
    });
    expect(messages[0].timestamp).toEqual(new Date(1756900000 * 1000));
  });

  it('aplana la respuesta de un botón a su id', () => {
    const { messages } = normalizeWebhook(envelope({
      ...metadata,
      messages: [{
        from: '573001112233', id: 'wamid.BTN', timestamp: '1756900001',
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'agendar', title: 'Agendar cita' } },
      }],
    }));
    expect(messages[0].type).toBe('interactive');
    expect(messages[0].text).toBe('agendar');
  });

  it('aplana la selección de una lista a su id', () => {
    const { messages } = normalizeWebhook(envelope({
      ...metadata,
      messages: [{
        from: '573001112233', id: 'wamid.LST', timestamp: '1756900002',
        type: 'interactive',
        interactive: { type: 'list_reply', list_reply: { id: 'srv_corte', title: 'Corte' } },
      }],
    }));
    expect(messages[0].text).toBe('srv_corte');
  });

  it('extrae el media_id de una imagen', () => {
    const { messages } = normalizeWebhook(envelope({
      ...metadata,
      messages: [{
        from: '573001112233', id: 'wamid.IMG', timestamp: '1756900003',
        type: 'image', image: { id: 'media-123', mime_type: 'image/jpeg' },
      }],
    }));
    expect(messages[0].type).toBe('image');
    expect(messages[0].mediaId).toBe('media-123');
    expect(messages[0].text).toBeNull();
  });

  it('normaliza los acuses de estado', () => {
    const { statuses, messages } = normalizeWebhook(envelope({
      ...metadata,
      statuses: [{ id: 'wamid.OUT', status: 'delivered', timestamp: '1756900004' }],
    }));
    expect(messages).toHaveLength(0);
    expect(statuses[0]).toMatchObject({ wamid: 'wamid.OUT', status: 'delivered' });
  });

  it('marca como unsupported un tipo desconocido en vez de lanzar', () => {
    const { messages } = normalizeWebhook(envelope({
      ...metadata,
      messages: [{ from: '573001112233', id: 'wamid.X', timestamp: '1756900005', type: 'sticker' }],
    }));
    expect(messages[0].type).toBe('unsupported');
  });

  it('devuelve listas vacías ante un payload irreconocible', () => {
    expect(normalizeWebhook({ hola: 'mundo' })).toEqual({ messages: [], statuses: [] });
  });
});

/**
 * El contrato de `normalizeWebhook` dice "nunca lanza", y esa promesa es la que
 * sostiene el endpoint del webhook: si esto revienta, Meta recibe un 500,
 * reintenta con backoff y termina desactivando el webhook del cliente.
 *
 * El test de payload irreconocible del brief solo prueba `{hola:'mundo'}`, que
 * queda atrapado por el único `Array.isArray(entries)` del código. Todo lo que
 * viene después —`changes`, `messages`, `statuses`, `contacts`— se recorre sin
 * comprobar que sea un arreglo, y `for...of` sobre un objeto lanza TypeError.
 */
describe('normalizeWebhook no lanza nunca', () => {
  const malformados: Array<[string, unknown]> = [
    ['changes es un objeto', { entry: [{ id: '1', changes: {} }] }],
    ['changes es un número', { entry: [{ id: '1', changes: 5 }] }],
    ['messages es un objeto', { entry: [{ id: '1', changes: [{ value: { messages: {} } }] }] }],
    ['messages es una cadena', { entry: [{ id: '1', changes: [{ value: { messages: 'abc' } }] }] }],
    ['statuses es un objeto', { entry: [{ id: '1', changes: [{ value: { statuses: {} } }] }] }],
    ['contacts es un objeto', { entry: [{ id: '1', changes: [{ value: { contacts: {}, messages: [] } }] }] }],
    ['entry trae null', { entry: [null] }],
    ['payload es null', null],
    ['payload es una cadena', 'no soy un webhook'],
  ];

  for (const [nombre, payload] of malformados) {
    it(`devuelve listas vacías cuando ${nombre}`, () => {
      expect(() => normalizeWebhook(payload)).not.toThrow();
      expect(normalizeWebhook(payload)).toEqual({ messages: [], statuses: [] });
    });
  }
});
