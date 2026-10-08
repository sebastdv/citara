export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** JSON seguro dentro de un <script>: un "</script>" en un valor no puede cerrar la etiqueta. */
const jsonForScript = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

export const layout = (title: string, body: string) => `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a}
button{font-size:1rem;padding:.75rem 1.25rem;border:0;border-radius:.5rem;background:#1877f2;color:#fff;cursor:pointer}
button:disabled{opacity:.6;cursor:default}#estado{margin-top:1rem}</style></head>
<body><main>${body}</main></body></html>`;

export function invalidLinkPage(): string {
  return layout('Enlace no válido',
    '<h1>Este enlace ya no es válido</h1><p>Puede que ya se haya usado o que haya vencido. Pide uno nuevo a quien te lo envió.</p>');
}

export function connectPage(p: { token: string; tenantName: string; appId: string; configId: string; graphVersion: string }): string {
  const cfg = jsonForScript({ token: p.token, appId: p.appId, configId: p.configId, graphVersion: p.graphVersion });
  return layout('Conectar WhatsApp', `
<h1>Conecta el WhatsApp de ${escapeHtml(p.tenantName)}</h1>
<p>Vas a vincular tu WhatsApp Business con el asistente de citas. Sigues usando tu app como siempre;
el asistente responde por ti cuando no estás en la conversación.</p>
<p>Ten a mano tu celular: Meta te pedirá escanear un código QR desde la app de WhatsApp Business.</p>
<button id="conectar" disabled>Conectar WhatsApp</button>
<p id="estado" role="status"></p>
<script>
const CFG = ${cfg};
const estado = (t) => { document.getElementById('estado').textContent = t; };
const boton = document.getElementById('conectar');
let sesion = null;
window.addEventListener('message', (e) => {
  try { if (!new URL(e.origin).hostname.endsWith('facebook.com')) return; } catch { return; }
  try {
    const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    if (d && d.type === 'WA_EMBEDDED_SIGNUP') sesion = d;
  } catch {}
});
window.fbAsyncInit = () => {
  FB.init({ appId: CFG.appId, autoLogAppEvents: true, xfbml: false, version: CFG.graphVersion });
  boton.disabled = false;
};
const completar = async (code) => {
  // El evento de la sesión puede llegar justo después del callback de login.
  for (let i = 0; i < 10 && !sesion; i++) await new Promise((r) => setTimeout(r, 300));
  const datos = (sesion && sesion.data) || {};
  const res = await fetch('/connect/whatsapp/complete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: CFG.token, code, waba_id: datos.waba_id, phone_number_id: datos.phone_number_id,
                           event: sesion && sesion.event }),
  });
  const r = await res.json().catch(() => ({}));
  if (res.ok) { estado('¡Listo! Tu WhatsApp ' + (r.numero || '') + ' quedó conectado. Ya puedes cerrar esta página.'); return; }
  estado(r.message || 'No se pudo completar la conexión. Intenta de nuevo.');
  boton.disabled = false;
};
boton.addEventListener('click', () => {
  boton.disabled = true;
  estado('Abriendo Meta…');
  FB.login((resp) => {
    const code = resp && resp.authResponse && resp.authResponse.code;
    if (!code) { estado('Se canceló la conexión.'); boton.disabled = false; return; }
    estado('Conectando…');
    completar(code).catch(() => { estado('No se pudo completar la conexión. Intenta de nuevo.'); boton.disabled = false; });
  }, {
    config_id: CFG.configId,
    response_type: 'code',
    override_default_response_type: true,
    // VERIFICAR en la consola de Meta: Embedded Signup v4 con coexistencia.
    extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' },
  });
});
</script>
<script async defer crossorigin="anonymous" src="https://connect.facebook.net/es_LA/sdk.js"></script>`);
}
