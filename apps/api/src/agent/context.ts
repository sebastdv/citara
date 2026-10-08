import type Anthropic from '@anthropic-ai/sdk';
import type { EntityManager } from 'typeorm';
import { BASE_PROMPT } from './prompt';
import { DateTime } from 'luxon';
import type { AgentConfig } from './ai-gate';

export interface BusinessFacts {
  name: string; timezone: string;
  services: { nombre: string; duracion_min: number; precio_centavos: number | null }[];
  resources: string[];
}

export async function loadFacts(m: EntityManager, tenantId: string): Promise<BusinessFacts> {
  const [t] = await m.query(`SELECT name, timezone FROM tenants WHERE id = $1`, [tenantId]);
  const services = await m.query(
    `SELECT name AS nombre, duration_min AS duracion_min, price_cents AS precio_centavos
       FROM services WHERE active ORDER BY name`);
  const resources = await m.query(`SELECT name FROM resources WHERE active ORDER BY name`);
  return { name: t.name, timezone: t.timezone, services, resources: resources.map((r: { name: string }) => r.name) };
}

const price = (cents: number | null) =>
  cents === null ? '' : `, $${Math.round(cents / 100).toLocaleString('es-CO')}`;

/** El system de un segmento. Determinista y sin nada volátil: se congela al empezar el segmento. */
export function buildSystem(facts: BusinessFacts, config: AgentConfig): string {
  const parts = [
    BASE_PROMPT,
    `El negocio: ${facts.name}. Zona horaria: ${facts.timezone}.`,
    `Servicios:\n${facts.services.map((s) => `- ${s.nombre} (${s.duracion_min} min${price(s.precio_centavos)})`).join('\n')}`,
    `Atienden: ${facts.resources.join(', ')}.`,
  ];
  if (config.instructions.trim()) parts.push(`Indicaciones del negocio:\n${config.instructions.trim()}`);
  return parts.join('\n\n');
}

/** El turno del usuario: la hora actual primero (no va en el system: invalidaría la caché). */
export function userTurn(
  now: Date, timezone: string, texts: string[], recent?: string | null,
): Anthropic.Beta.Messages.BetaMessageParam {
  const content: Anthropic.Beta.Messages.BetaTextBlockParam[] = [
    // Con el año: el modelo arma fechas ISO para las herramientas.
    { type: 'text', text: `Ahora: ${DateTime.fromJSDate(now).setZone(timezone).setLocale('es')
      .toFormat("cccc d 'de' LLLL 'de' yyyy, HH:mm")} (${timezone}).` },
  ];
  if (recent) content.push({ type: 'text', text: `Conversación reciente con este cliente:\n${recent}` });
  content.push({ type: 'text', text: texts.join('\n') });
  return { role: 'user', content };
}

/** Lo que se habló antes de entrar al agente, para que no pregunte lo que ya se respondió. */
export async function recentHistory(
  m: EntityManager, conversationId: string, before: Date, limit = 10,
): Promise<string | null> {
  const rows: { origin: string; body: string }[] = await m.query(
    `SELECT origin, body FROM (
       SELECT origin, body, created_at FROM messages
        WHERE conversation_id = $1 AND created_at < $2 AND body IS NOT NULL AND body <> ''
          AND origin IN ('customer', 'bot', 'phone', 'operator', 'history')
        ORDER BY created_at DESC LIMIT $3) x
      ORDER BY created_at`, [conversationId, before, limit]);
  if (!rows.length) return null;
  return rows.map((r) => `${r.origin === 'customer' ? 'Cliente' : 'Negocio'}: ${r.body}`).join('\n');
}
