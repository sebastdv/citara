import { DateTime } from 'luxon';
import { html, type SafeHtml } from './html';
import { csrfField, panelPage, type PageCtx } from './layout';
import { canSendFreeform } from '../conversations/session-window';
import { CHAT_LIMIT, type ChatView } from './conversation';
import type { Cursor, InboxFilter, InboxRow } from './inbox';
import type { PanelTenant } from './tenants';
import type { AuditFilter, AuditRow } from './audit-view';
import type { CostRow } from './costs';
import type { Estado } from './estado';
import type { Alert } from './alerts';

export const fmtIn = (d: Date, tz: string) =>
  DateTime.fromJSDate(d).setZone(tz).setLocale('es').toFormat('d LLL HH:mm');

const ORIGIN: Record<string, string> = {
  customer: 'Cliente', bot: 'Bot', phone: 'Dueño (celular)', operator: 'Operador',
  history: 'Historial', reminder: 'Recordatorio',
};
const STATUS: Record<string, string> = {
  pending: 'pendiente', sending: 'enviando', sent: 'enviado', delivered: 'entregado', read: 'leído',
  superseded: 'descartado: tomó un humano', window_closed: 'no salió: ventana cerrada',
  failed: 'falló', unconfirmed: 'sin confirmar: pudo o no llegar',
};
const REASON: Record<string, string> = {
  phone: 'el dueño escribió desde su celular', flow_handoff: 'el flujo pidió un humano',
  operator: 'lo tomó el operador', history: 'el dueño estaba activo (historial)',
};
const reasonText = (r: string | null) => (r ? REASON[r] ?? r : '');

export const chatUrl = (slug: string, id: string) =>
  `/panel/negocios/${encodeURIComponent(slug)}/conversaciones/${id}`;
const who = (name: string | null, waId: string) => (name ? `${name} · +${waId}` : `+${waId}`);
const cursorParam = (c: Cursor) => `${c.at}_${c.id}`;
const query = (base: string, o: Record<string, string | undefined>) =>
  `${base}?${new URLSearchParams(Object.entries(o).filter(([, v]) => v) as [string, string][]).toString()}`;
const tenantSelect = (tenants: PanelTenant[], slug?: string) => html`<select name="negocio">
  <option value="">Todos los negocios</option>
  ${tenants.map((t) => html`<option value="${t.slug}" ${t.slug === slug ? html`selected` : ''}>${t.name}</option>`)}
</select>`;

export function loginView(nonce: string, p: { next: string; error?: string; email?: string }): string {
  return panelPage('Entrar', { nonce }, html`
    <h1>Panel de Citara</h1>
    ${p.error ? html`<p class="alerta" role="alert">${p.error}</p>` : ''}
    <form method="post" action="/panel/login">
      <input type="hidden" name="next" value="${p.next}">
      <p><label>Correo<br><input name="email" type="email" autocomplete="username" required value="${p.email ?? ''}"></label></p>
      <p><label>Contraseña<br><input name="password" type="password" autocomplete="current-password" required></label></p>
      <button>Entrar</button>
    </form>`);
}

/** Por qué no se le puede escribir ahora al cliente; null si se puede. */
export function sendRestriction(chat: ChatView, now: Date): string | null {
  if (chat.tenantStatus !== 'active') return 'El negocio no está activo: no sale nada.';
  if (chat.channelStatus !== 'active') return 'El canal de WhatsApp está desconectado.';
  if (!canSendFreeform(chat.lastInboundAt, now)) {
    return 'El cliente no ha escrito o pasaron más de 24 h: WhatsApp solo deja escribirle con una plantilla.';
  }
  return null;
}

export function inboxList(rows: InboxRow[], now: Date): SafeHtml {
  if (!rows.length) return html`<p>No hay conversaciones aquí.</p>`;
  return html`<div class="tabla"><table>
    <thead><tr><th>Negocio</th><th>Contacto</th><th>Quién habla</th><th>Último mensaje</th></tr></thead><tbody>
    ${rows.map((r) => {
      const tz = r.tenant.timezone;
      const human = r.control === 'human' && r.humanUntil !== null && r.humanUntil > now;
      return html`<tr>
        <td>${r.tenant.name}<br><span class="meta">${r.mode === 'cloud_api' ? 'número dedicado' : 'coexistencia'}</span></td>
        <td><a href="${chatUrl(r.tenant.slug, r.conversationId)}">${who(r.contactName, r.waId)}</a></td>
        <td>${human
          ? html`<span class="tag">Humano</span> ${reasonText(r.reason)}<br><span class="meta">hasta ${fmtIn(r.humanUntil!, tz)}</span>`
          : html`<span class="tag">Bot</span>`}</td>
        <td>${r.lastDirection === 'in'
          ? html`<strong>El cliente espera desde ${fmtIn(r.lastMessageAt, tz)}</strong>`
          : html`<span class="meta">${fmtIn(r.lastMessageAt, tz)}</span>`}<br><pre>${r.lastPreview}</pre></td>
      </tr>`;
    })}</tbody></table></div>`;
}

export function inboxView(
  ctx: PageCtx, d: { filter: InboxFilter; tenants: PanelTenant[]; rows: InboxRow[]; next: Cursor | null }, now: Date,
): string {
  const f = d.filter;
  return panelPage('Bandeja', ctx, html`
    <h1>Bandeja</h1>
    <p>${f.tab === 'traspasos' ? html`<strong>Traspasos abiertos</strong>` : html`<a href="${query('/panel', { tab: 'traspasos', negocio: f.slug })}">Traspasos abiertos</a>`} ·
       ${f.tab === 'todas' ? html`<strong>Todas</strong>` : html`<a href="${query('/panel', { tab: 'todas', negocio: f.slug })}">Todas</a>`}</p>
    <form method="get" action="/panel"><input type="hidden" name="tab" value="${f.tab}">
      ${tenantSelect(d.tenants, f.slug)} <button>Filtrar</button></form>
    <div id="lista" data-refresh="15000">${inboxList(d.rows, now)}</div>
    ${d.next ? html`<p><a href="${query('/panel', { tab: f.tab, negocio: f.slug, antes: cursorParam(d.next) })}">Más antiguas →</a></p>` : ''}`);
}

export function chatMessages(chat: ChatView, tz: string): SafeHtml {
  return html`${chat.messages.length >= CHAT_LIMIT ? html`<p class="meta">Se muestran los últimos ${CHAT_LIMIT} mensajes.</p>` : ''}
    ${chat.messages.length ? '' : html`<p class="meta">Sin mensajes.</p>`}
    ${chat.messages.map((m) => html`<div class="msg ${m.direction === 'out' ? 'out' : ''}">
      <div class="meta">${ORIGIN[m.origin] ?? m.origin} · ${fmtIn(m.at, tz)}${m.direction === 'out' && m.status ? html` · ${STATUS[m.status] ?? m.status}` : ''}</div>
      <pre>${m.text}</pre></div>`)}`;
}

export function chatView(
  ctx: PageCtx, d: { tenant: PanelTenant; chat: ChatView; draft?: string; notice?: string; submissionId: string }, now: Date,
): string {
  const { tenant, chat } = d;
  const tz = tenant.timezone;
  const url = chatUrl(tenant.slug, chat.conversationId);
  const human = chat.control === 'human' && chat.humanUntil !== null && chat.humanUntil > now;
  const mine = human && chat.reason === 'operator';
  const blocked = sendRestriction(chat, now);
  const windowEnd = chat.lastInboundAt ? new Date(chat.lastInboundAt.getTime() + 24 * 3600 * 1000) : null;
  return panelPage(who(chat.contactName, chat.waId), ctx, html`
    <p><a href="/panel">← Bandeja</a> ·
       <a href="${query('/panel/auditoria', { negocio: tenant.slug, conversacion: chat.conversationId })}">Auditoría de esta conversación</a></p>
    <h1>${who(chat.contactName, chat.waId)}</h1>
    <p>${tenant.name} · ${chat.mode === 'cloud_api' ? 'número dedicado' : 'coexistencia'}
       ${tenant.status !== 'active' ? html` · <span class="tag">negocio ${tenant.status}</span>` : ''}
       ${chat.channelStatus !== 'active' ? html` · <span class="tag">canal ${chat.channelStatus}</span>` : ''}</p>
    <p>${human ? html`<strong>Manda un humano</strong>: ${reasonText(chat.reason)}, hasta ${fmtIn(chat.humanUntil!, tz)}.`
               : html`<strong>Manda el bot.</strong>`}
       ${windowEnd && windowEnd > now ? html`Ventana abierta hasta ${fmtIn(windowEnd, tz)}.` : html`Ventana cerrada.`}</p>
    ${d.notice ? html`<p class="alerta" role="alert">${d.notice}</p>` : ''}
    <p>${mine ? '' : html`<form class="inline" method="post" action="${url}/tomar">${csrfField(ctx)}<button>Tomar el control</button></form>`}
       ${human ? html`<form class="inline" method="post" action="${url}/devolver">${csrfField(ctx)}<button>Devolver al bot</button></form>` : ''}</p>
    <div id="mensajes" data-refresh="5000">${chatMessages(chat, tz)}</div>
    ${chat.hasPendingOperator ? html`<form method="post" action="${url}/reintentar">${csrfField(ctx)}
      <p class="alerta">Hay mensajes tuyos sin enviar. <button>Reintentar</button></p></form>` : ''}
    <form method="post" action="${url}/responder">${csrfField(ctx)}
      <input type="hidden" name="envio" value="${d.submissionId}">
      ${blocked ? html`<p class="alerta">${blocked}</p>` : ''}
      <textarea name="texto" maxlength="4096" ${blocked ? html`disabled` : ''}>${d.draft ?? ''}</textarea>
      <p><button ${blocked ? html`disabled` : ''}>Enviar</button> <span class="meta">Enviar te da el control de la conversación.</span></p>
    </form>`);
}

export function auditView(
  ctx: PageCtx, d: { filter: AuditFilter; tenants: PanelTenant[]; rows: AuditRow[]; next: Cursor | null },
): string {
  const f = d.filter;
  return panelPage('Auditoría', ctx, html`
    <h1>Auditoría</h1>
    <form method="get" action="/panel/auditoria">
      ${tenantSelect(d.tenants, f.slug)}
      <input name="accion" placeholder="control., agent., channel." value="${f.action ?? ''}">
      ${f.conversationId ? html`<input type="hidden" name="conversacion" value="${f.conversationId}">` : ''}
      <button>Filtrar</button></form>
    ${f.conversationId ? html`<p class="meta">Solo una conversación. <a href="${query('/panel/auditoria', { negocio: f.slug, accion: f.action })}">Ver todas</a></p>` : ''}
    ${d.rows.length ? html`<div class="tabla"><table>
      <thead><tr><th>Fecha</th><th>Negocio</th><th>Actor</th><th>Acción</th><th>Detalle</th></tr></thead><tbody>
      ${d.rows.map((r) => html`<tr><td>${fmtIn(r.at, r.tenant.timezone)}</td><td>${r.tenant.name}</td><td>${r.actor}</td>
        <td>${r.action}${r.conversationId ? html`<br><a href="${chatUrl(r.tenant.slug, r.conversationId)}">conversación</a>` : ''}</td>
        <td><pre>${JSON.stringify(r.details)}</pre></td></tr>`)}
      </tbody></table></div>` : html`<p>No hay registros.</p>`}
    ${d.next ? html`<p><a href="${query('/panel/auditoria', { negocio: f.slug, accion: f.action, conversacion: f.conversationId, antes: cursorParam(d.next) })}">Más antiguos →</a></p>` : ''}`);
}

const usd = (n: number) =>
  `US$ ${n.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;

export function costsView(ctx: PageCtx, d: { ym: { year: number; month: number }; rows: CostRow[] }): string {
  const label = `${d.ym.year}-${String(d.ym.month).padStart(2, '0')}`;
  return panelPage('Costos', ctx, html`
    <h1>Costo de IA por cita</h1>
    <form method="get" action="/panel/costos"><input type="month" name="mes" value="${label}"> <button>Ver</button></form>
    <p class="meta">Mes calendario en la zona horaria de cada negocio. Las citas son las creadas en el mes,
       aunque luego se hayan cancelado: el gasto para agendarlas ya se hizo.</p>
    ${d.rows.length ? html`<div class="tabla"><table>
      <thead><tr><th>Negocio</th><th>Agente</th><th>Intérprete</th><th>Llamadas</th><th>Tope del mes</th>
                 <th>Citas (agente / menús)</th><th>Costo por cita</th></tr></thead><tbody>
      ${d.rows.map((r) => {
        const total = r.agentUsd + r.interpretUsd;
        const cap = r.budgetUsd === null ? 'sin IA' : !r.enabled ? 'apagada'
          : `${usd(r.budgetUsd)} (${r.budgetUsd ? Math.round((total / r.budgetUsd) * 100) : 0} %)`;
        return html`<tr><td>${r.tenant.name}</td><td>${usd(r.agentUsd)}</td><td>${usd(r.interpretUsd)}</td>
          <td>${r.calls}${r.failed ? html` <span class="meta">(${r.failed} fallidas)</span>` : ''}</td><td>${cap}</td>
          <td>${r.appointments} (${r.byAgent} / ${r.byFlow})</td>
          <td>${r.usdPerAppointment === null ? '—' : usd(r.usdPerAppointment)}</td></tr>`;
      })}</tbody></table></div>` : html`<p>No hay negocios.</p>`}`);
}

const SEVERITY: Record<Alert['severity'], string> = { critical: 'Crítico', warning: 'Aviso', info: 'Info' };

const alertList = (alerts: Alert[]) => alerts.length
  ? html`<ul>${alerts.map((a) => html`<li><span class="tag sev-${a.severity}">${SEVERITY[a.severity]}</span> ${a.message}</li>`)}</ul>`
  : html`<p class="meta">Sin avisos.</p>`;

export function estadoView(ctx: PageCtx, d: Estado, now: Date): string {
  const b = d.system.backup;
  const backupLine = !b.configured ? 'Sin carpeta de respaldos (desarrollo).'
    : b.last ? `Último respaldo nocturno: ${b.last} (hace ${b.ageHours} h).` : 'Sin respaldos nocturnos.';
  const failedTotal = d.system.queues?.reduce((n, q) => n + q.failed, 0);
  return panelPage('Estado', ctx, html`
    <h1>Estado</h1>
    <h2>Servidor</h2>
    <p>${backupLine} ${d.system.queues === null ? 'Redis no responde.' : `Jobs fallidos en las colas: ${failedTotal}.`}</p>
    ${alertList(d.system.alerts)}
    <h2>Negocios</h2>
    ${d.tenants.length ? d.tenants.map((t) => html`<section>
      <h3>${t.summary.name} <span class="meta">${t.summary.slug} · ${t.summary.mode === 'coexistence' ? 'coexistencia' : t.summary.mode === 'cloud_api' ? 'número dedicado' : 'sin número'}${t.summary.phone ? html` · ${t.summary.phone}` : ''}</span></h3>
      ${alertList(t.alerts)}
    </section>`) : html`<p>No hay negocios.</p>`}
    <p class="meta">Calculado ${fmtIn(now, 'America/Bogota')} (hora de Bogotá). Recarga la página para actualizar.</p>`);
}
