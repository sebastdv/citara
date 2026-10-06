import { describe, it, expect } from 'vitest';
import { normalizeWebhook } from '../../src/whatsapp/normalizer';
import {
  accountUpdatePayload, contactsPayload, echoPayload, historyDeclinedPayload,
  historyPayload, statusPayload,
} from './fixtures/coexistence';

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
    expect(normalizeWebhook({ hola: 'mundo' })).toEqual({ messages: [], statuses: [], echoes: [], history: [], contacts: [], accountUpdates: [] });
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
      expect(normalizeWebhook(payload)).toEqual({ messages: [], statuses: [], echoes: [], history: [], contacts: [], accountUpdates: [] });
    });
  }
});

describe('normalizeWebhook — coexistencia', () => {
  it('normaliza un eco del celular del negocio', () => {
    const at = new Date('2026-10-06T15:00:00Z');
    const n = normalizeWebhook(echoPayload({ wamid: 'wamid.E1', to: '573001112233', text: 'Ya voy', at }));

    expect(n.messages).toEqual([]);
    expect(n.echoes).toEqual([expect.objectContaining({
      wamid: 'wamid.E1', phoneNumberId: '106540', wabaId: '102290',
      to: '573001112233', type: 'text', text: 'Ya voy', timestamp: at,
    })]);
  });

  it('quita el + del destinatario del eco para que caiga en el mismo contacto', () => {
    const n = normalizeWebhook(echoPayload({ wamid: 'wamid.E2', to: '+573001112233' }));
    expect(n.echoes[0].to).toBe('573001112233');
  });

  it('normaliza un chunk de historial con sus hilos y fase', () => {
    const at = new Date('2026-10-05T10:00:00Z');
    const n = normalizeWebhook(historyPayload({
      customer: '573001112233', phase: 1, progress: 40,
      lines: [{ wamid: 'wamid.H1', fromCustomer: true, text: 'Hola', at }],
    }));

    expect(n.history).toHaveLength(1);
    expect(n.history[0]).toMatchObject({ phoneNumberId: '106540', phase: 1, progress: 40, declined: false });
    expect(n.history[0].threads[0].waId).toBe('573001112233');
    expect(n.history[0].threads[0].messages[0]).toMatchObject(
      { wamid: 'wamid.H1', from: '573001112233', text: 'Hola', timestamp: at });
  });

  it('reconoce que el negocio no compartió el historial', () => {
    const n = normalizeWebhook(historyDeclinedPayload());
    expect(n.history).toEqual([expect.objectContaining({ declined: true, threads: [] })]);
  });

  it('normaliza los contactos agregados y quitados', () => {
    const add = normalizeWebhook(contactsPayload({ phone: '573001112233', name: 'Ana Pérez', action: 'add' }));
    const del = normalizeWebhook(contactsPayload({ phone: '573001112233', name: 'Ana Pérez', action: 'remove' }));
    expect(add.contacts).toEqual([expect.objectContaining(
      { waId: '573001112233', name: 'Ana Pérez', action: 'add', phoneNumberId: '106540' })]);
    expect(del.contacts[0].action).toBe('remove');
  });

  it('normaliza un aviso de la cuenta', () => {
    expect(normalizeWebhook(accountUpdatePayload('PARTNER_REMOVED')).accountUpdates)
      .toEqual([{ wabaId: '102290', event: 'PARTNER_REMOVED', phoneNumber: '15550001' }]);
  });

  it('los estados llevan el número por el que salieron', () => {
    const n = normalizeWebhook(statusPayload('wamid.OUT', 'delivered'));
    expect(n.statuses[0]).toMatchObject({ wamid: 'wamid.OUT', status: 'delivered', phoneNumberId: '106540' });
  });

  it('ignora los campos a los que no estamos suscritos', () => {
    const n = normalizeWebhook({ entry: [{ id: '1', changes: [{ field: 'message_template_status_update',
      value: { event: 'APPROVED' } }] }] });
    expect(Object.values(n).every((list) => list.length === 0)).toBe(true);
  });

  const malformados: [string, unknown][] = [
    ['message_echoes no es arreglo', { entry: [{ id: '1', changes: [{ field: 'smb_message_echoes', value: { message_echoes: 'x' } }] }] }],
    ['history trae threads como objeto', { entry: [{ id: '1', changes: [{ field: 'history', value: { history: [{ threads: {} }] } }] }] }],
    ['state_sync es null', { entry: [{ id: '1', changes: [{ field: 'smb_app_state_sync', value: { state_sync: null } }] }] }],
    ['account_update sin event', { entry: [{ id: '1', changes: [{ field: 'account_update', value: {} }] }] }],
  ];
  for (const [nombre, payload] of malformados) {
    it(`no lanza cuando ${nombre}`, () => {
      expect(() => normalizeWebhook(payload)).not.toThrow();
    });
  }
});
