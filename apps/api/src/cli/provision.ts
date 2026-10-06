import type { DataSource } from 'typeorm';
import type { FlowDefinition } from '@citara/shared';
import type { EncryptionService } from '../crypto/encryption.service';

/**
 * Alta de un negocio para DESARROLLO: tenant, canal de WhatsApp con su token
 * cifrado y un flujo activo por defecto. Hasta que exista el alta autoservicio
 * de la Fase 6, es la única forma de dejar un número listo para recibir
 * mensajes reales sin escribir SQL a mano.
 *
 * Va por la conexión ADMIN: la aplicación no tiene escritura sobre `tenants`
 * ni sobre `whatsapp_channels` (ver RestrictAppPrivileges), y así debe seguir.
 */
export interface ProvisionInput {
  slug: string;
  name: string;
  timezone: string;
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
  displayPhoneNumber?: string;
  flow: FlowDefinition;
}

export interface ProvisionResult {
  tenantId: string;
  channelId: string;
  flowId: string;
}

const FLOW_VERSION = 'dev';

/** Idempotente: repetirlo actualiza en vez de duplicar, y rota el token. */
export async function provisionDevTenant(
  admin: DataSource, enc: EncryptionService, input: ProvisionInput,
): Promise<ProvisionResult> {
  return admin.transaction(async (m) => {
    const [tenant] = await m.query(
      `INSERT INTO tenants (slug, name, timezone) VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, timezone = EXCLUDED.timezone
       RETURNING id`,
      [input.slug, input.name, input.timezone],
    );

    // El WHERE del DO UPDATE impide que un número ya registrado cambie de
    // dueño: si pertenece a otro tenant no se actualiza nada, no vuelve fila
    // y se aborta. Reasignar un número desvía el tráfico de un cliente a otro.
    const [channel] = await m.query(
      `INSERT INTO whatsapp_channels
         (tenant_id, waba_id, phone_number_id, display_phone_number, access_token_encrypted)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (phone_number_id) DO UPDATE
         SET waba_id = EXCLUDED.waba_id,
             display_phone_number = EXCLUDED.display_phone_number,
             access_token_encrypted = EXCLUDED.access_token_encrypted,
             status = 'active'
       WHERE whatsapp_channels.tenant_id = EXCLUDED.tenant_id
       RETURNING id`,
      [tenant.id, input.wabaId, input.phoneNumberId, input.displayPhoneNumber ?? null,
       enc.encrypt(input.accessToken)],
    );
    if (!channel) {
      throw new Error(
        `El phone_number_id ${input.phoneNumberId} ya pertenece a otro negocio; no se reasigna`);
    }

    // Un solo flujo activo por defecto por tenant (índice flows_one_default):
    // se apagan los demás antes de encender este.
    await m.query(
      `UPDATE flows SET is_default = false
        WHERE tenant_id = $1 AND NOT (key = $2 AND version = $3)`,
      [tenant.id, input.flow.key, FLOW_VERSION],
    );
    const [flow] = await m.query(
      `INSERT INTO flows (tenant_id, key, version, definition, is_active, is_default)
       VALUES ($1, $2, $3, $4, true, true)
       ON CONFLICT (tenant_id, key, version) DO UPDATE
         SET definition = EXCLUDED.definition, is_active = true, is_default = true
       RETURNING id`,
      [tenant.id, input.flow.key, FLOW_VERSION, JSON.stringify(input.flow)],
    );

    return { tenantId: tenant.id, channelId: channel.id, flowId: flow.id };
  });
}

/** Flujo de demostración: ejercita message, choice, capture, end y handoff. */
export const DEMO_FLOW: FlowDefinition = {
  key: 'demo',
  entry: 'saludo',
  steps: {
    saludo: { type: 'message', text: '¡Hola! Soy el asistente de Citara 👋', next: 'menu' },
    menu: {
      type: 'choice', kind: 'interactive_buttons', text: '¿En qué te ayudo?',
      buttons: [
        { id: 'agendar', title: 'Agendar cita', next: 'pide_nombre' },
        { id: 'asesor', title: 'Hablar con alguien', next: 'humano' },
      ],
    },
    pide_nombre: {
      type: 'capture', text: '¿A nombre de quién?', var: 'nombre',
      validate: 'text', next: 'listo',
    },
    listo: { type: 'end', text: 'Perfecto, {{nombre}}. Te contactamos pronto.' },
    humano: { type: 'handoff', text: 'Te comunico con alguien del equipo.' },
  },
};
