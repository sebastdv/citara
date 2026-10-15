import type { TenantSummary } from '../cli/tenants';

export type Severity = 'critical' | 'warning' | 'info';
export type AlertArea = 'negocio' | 'canal' | 'dueño' | 'sincronización' | 'google' | 'ia' | 'envíos';
export interface Alert { severity: Severity; area: AlertArea; message: string }

const DAY_MS = 86_400_000;
/** Meta corta la sincronización de un número en coexistencia si el dueño no abre la app en 14 días. */
export const OWNER_WARNING_DAYS = 10;
export const OWNER_CRITICAL_DAYS = 14;
export const AI_INFO_RATIO = 0.8;
const ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
const SYNC_NAMES: Record<string, string> = { smb_app_state_sync: 'los contactos', history: 'el historial' };

/**
 * Lo que el operador tiene que mirar de un negocio, de lo más grave a lo
 * menos grave. Puro: todo sale del resumen y de `now`.
 */
export function alertsFor(s: TenantSummary, now: Date): Alert[] {
  const out: Alert[] = [];
  const add = (severity: Severity, area: AlertArea, message: string) => out.push({ severity, area, message });

  if (s.status === 'onboarding') add('info', 'negocio', 'En alta: guarda lo que llega, pero todavía no responde.');
  if (s.status === 'suspended') add('info', 'negocio', 'Suspendido: no responde ni envía nada.');

  if (s.channelStatus === null) {
    if (s.status === 'onboarding') add('info', 'canal', 'Todavía no conectó su número de WhatsApp.');
    else add('warning', 'canal', 'No tiene un número de WhatsApp conectado.');
  } else if (s.channelStatus !== 'active') {
    add('critical', 'canal', `El canal de WhatsApp está ${s.channelStatus === 'disconnected' ? 'desconectado' : 'inactivo'}: no entra ni sale nada.`);
  }

  if (s.mode === 'coexistence' && s.channelStatus === 'active') {
    // Un eco es un mensaje que el dueño manda desde su celular: si deja de haberlos,
    // quizá no está abriendo la app. Es una señal aproximada (abrirla sin escribir no se ve).
    const since = s.lastPhoneEcho ?? s.channelCreatedAt;
    const days = since ? Math.floor((now.getTime() - since.getTime()) / DAY_MS) : 0;
    if (days >= OWNER_WARNING_DAYS) {
      const what = s.lastPhoneEcho
        ? `El dueño no escribe desde su celular hace ${days} días`
        : `El dueño nunca escribió desde su celular desde que se conectó el número (hace ${days} días)`;
      add(days >= OWNER_CRITICAL_DAYS ? 'critical' : 'warning', 'dueño',
        `${what}. Meta corta la sincronización si no abre la app de WhatsApp Business en ${OWNER_CRITICAL_DAYS} días: pídele que la abra.`);
    }
  }

  for (const [type, result] of Object.entries(s.syncs)) {
    if (result === 'failed') {
      add('warning', 'sincronización', `Falló la sincronización de ${SYNC_NAMES[type] ?? type}: reintenta con pnpm tenant sync ${s.slug} (Meta la acepta dentro de las 24 h del alta).`);
    }
  }
  if (s.historySync === 'pending' && s.channelCreatedAt && now.getTime() - s.channelCreatedAt.getTime() > DAY_MS) {
    add('warning', 'sincronización', 'El historial lleva más de 24 h pendiente: el dueño puede no haber aceptado compartirlo.');
  }

  for (const g of s.google) {
    if (g.status === 'needs_reauth') { add('critical', 'google', `${g.resource}: hay que reconectar su Google Calendar (las citas siguen agendándose, pero no se ven en su calendario).`); continue; }
    if (!g.calendar) add('warning', 'google', `${g.resource}: no tiene el calendario «Citas» creado.`);
    if (g.watchError) add('warning', 'google', `${g.resource}: fallan los avisos de cambios en su calendario.`);
    else if (g.watchExpiresAt && new Date(g.watchExpiresAt) < now) add('warning', 'google', `${g.resource}: los avisos de cambios en su calendario vencieron.`);
    if (g.unsynced > 0) add('warning', 'google', `${g.resource}: ${g.unsynced} citas sin subir a su calendario.`);
  }

  if (s.ai?.enabled && s.ai.budgetUsd > 0) {
    const money = `${s.ai.spentUsd.toFixed(2)} de ${s.ai.budgetUsd.toFixed(2)} USD`;
    if (s.ai.spentUsd >= s.ai.budgetUsd) add('warning', 'ia', `IA agotada este mes (${money}): el negocio atiende solo con menús.`);
    else if (s.ai.spentUsd >= s.ai.budgetUsd * AI_INFO_RATIO) add('info', 'ia', `IA al ${Math.floor((s.ai.spentUsd / s.ai.budgetUsd) * 100)} % del tope (${money}).`);
  }

  if (s.failedOutbound24h > 0) {
    add('warning', 'envíos', `${s.failedOutbound24h} mensajes no salieron en las últimas 24 h (fallidos o sin confirmar): revisa sus chats.`);
  }

  // sort es estable: dentro de una gravedad se conserva el orden de arriba.
  return out.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}
