import { escapeHtml, layout } from '../onboarding/connect-page';

export function connectGooglePage(p: { tenantName: string; resourceName: string; authUrl: string }): string {
  return layout('Conectar Google Calendar', `
<h1>Conecta el Google Calendar de ${escapeHtml(p.resourceName)}</h1>
<p>${escapeHtml(p.tenantName)} usa un asistente que agenda citas por WhatsApp.</p>
<p>Al conectar, el asistente crea en tu cuenta un calendario llamado
<strong>«Citas · ${escapeHtml(p.resourceName)}»</strong> donde aparecen tus citas, y consulta en tu
calendario principal cuándo estás ocupado para no ofrecer esas horas. No lee el contenido de tus eventos.</p>
<p>Si mueves o borras una cita en ese calendario, el asistente se entera.</p>
<p><a href="${escapeHtml(p.authUrl)}" rel="noreferrer"><button type="button">Conectar Google Calendar</button></a></p>`);
}

export function resultPage(title: string, message: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}
