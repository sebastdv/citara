/**
 * Payloads de coexistencia con la FORMA de la documentación de Meta
 * (developers.facebook.com → Onboard WhatsApp Business app users), escritos a
 * mano: NO son grabaciones. Al conectar el primer número real se graban los
 * payloads verdaderos y se reemplazan aquí; si difieren, manda la grabación.
 */
const BUSINESS = '15550001';
const PHONE_NUMBER_ID = '106540';
const WABA = '102290';

const envelope = (field: string, value: unknown) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: WABA, changes: [{ field, value }] }],
});
const metadata = { display_phone_number: BUSINESS, phone_number_id: PHONE_NUMBER_ID };
const unix = (d: Date) => String(Math.floor(d.getTime() / 1000));

export const echoPayload = (o: { wamid: string; to: string; text?: string; at?: Date; type?: string }) =>
  envelope('smb_message_echoes', {
    messaging_product: 'whatsapp', metadata,
    message_echoes: [{
      from: BUSINESS, to: o.to, id: o.wamid, timestamp: unix(o.at ?? new Date()),
      type: o.type ?? 'text', ...(o.type && o.type !== 'text' ? {} : { text: { body: o.text ?? 'Ya te atiendo' } }),
    }],
  });

export interface HistoryLine { wamid: string; fromCustomer: boolean; text: string; at: Date }

export const historyPayload = (o: {
  customer: string; lines: HistoryLine[]; phase?: number; progress?: number;
}) => envelope('history', {
  messaging_product: 'whatsapp', metadata,
  history: [{
    metadata: { phase: o.phase ?? 2, chunk_order: 1, progress: o.progress ?? 100 },
    threads: [{
      id: o.customer,
      messages: o.lines.map((l) => ({
        from: l.fromCustomer ? o.customer : BUSINESS, id: l.wamid, timestamp: unix(l.at),
        type: 'text', text: { body: l.text }, history_context: { status: 'READ' },
      })),
    }],
  }],
});

/** VERIFICAR: código y forma del rechazo a compartir el historial. */
export const historyDeclinedPayload = () => envelope('history', {
  messaging_product: 'whatsapp', metadata,
  history: [{ errors: [{ code: 2593109, title: 'History sharing is turned off by the business' }] }],
});

export const contactsPayload = (o: { phone: string; name: string; action: 'add' | 'remove' }) =>
  envelope('smb_app_state_sync', {
    messaging_product: 'whatsapp', metadata,
    state_sync: [{
      type: 'contact', action: o.action, metadata: { timestamp: unix(new Date()) },
      contact: { full_name: o.name, first_name: o.name.split(' ')[0], phone_number: o.phone },
    }],
  });

/** VERIFICAR: nombres de evento de account_update. */
export const accountUpdatePayload = (event: string) =>
  envelope('account_update', { phone_number: BUSINESS, event });

export const statusPayload = (wamid: string, status: string) => envelope('messages', {
  messaging_product: 'whatsapp', metadata,
  statuses: [{ id: wamid, status, timestamp: unix(new Date()), recipient_id: '573001112233' }],
});
