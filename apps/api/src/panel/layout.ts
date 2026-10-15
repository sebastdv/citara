import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { html, raw, type SafeHtml } from './html';

export interface PageCtx { nonce: string; csrf: string; email: string }

export const newNonce = () => randomBytes(16).toString('base64');

/** Toda respuesta del panel, página o fragmento, sale con estas cabeceras. */
export function sendHtml(res: Response, status: number, page: string, nonce: string): void {
  res.setHeader('Content-Security-Policy',
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; ` +
    `form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  // same-origin y no no-referrer: con no-referrer el navegador manda `Origin: null`
  // en los POST de formulario y el panel no podría distinguirlos de otro sitio.
  res.setHeader('Referrer-Policy', 'same-origin');
  res.status(status).type('html').send(page);
}

export const csrfField = (ctx: PageCtx) => html`<input type="hidden" name="_csrf" value="${ctx.csrf}">`;

const STYLE = `
body{font-family:system-ui,sans-serif;margin:0;color:#1a1a1a;background:#fafafa;line-height:1.45}
nav{display:flex;gap:1rem;align-items:center;padding:.75rem 1rem;background:#fff;border-bottom:1px solid #ddd;flex-wrap:wrap}
nav a{color:#1a1a1a;text-decoration:none}nav a:hover{text-decoration:underline}nav form{margin-left:auto}
main{max-width:64rem;margin:0 auto;padding:1rem}
.tabla{overflow-x:auto}table{border-collapse:collapse;width:100%;background:#fff}
th,td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid #eee;vertical-align:top}
.tag{display:inline-block;padding:0 .4rem;border-radius:.25rem;background:#eee;font-size:.85em}
.alerta{background:#fff3cd;padding:.5rem .75rem;border-radius:.25rem}
.sev-critical{background:#f8d7da;color:#842029}.sev-warning{background:#fff3cd;color:#664d03}.sev-info{background:#e2e3e5}
.msg{background:#fff;border:1px solid #eee;border-radius:.5rem;padding:.4rem .6rem;margin:.4rem 0;max-width:40rem}
.out{margin-left:auto;background:#eef6ff}.meta{color:#666;font-size:.8em}
textarea{width:100%;min-height:5rem;font:inherit;box-sizing:border-box}button{font:inherit;padding:.4rem .9rem;cursor:pointer}
form.inline{display:inline}pre{white-space:pre-wrap;word-break:break-word;margin:0;font:inherit}`;

// Refresca solo los elementos marcados, sin tocar lo que el operador escribe.
// Si la sesión venció, el servidor redirige al login: se recarga la página
// entera en vez de meter el login dentro de la lista. Un 5xx o un corte de red
// (un despliegue, Caddy reiniciando) no recarga: se reintenta en el siguiente
// intervalo y el borrador sobrevive.
export const REFRESH_SCRIPT = `
document.querySelectorAll('[data-refresh]').forEach(function (el) {
  setInterval(async function () {
    if (document.hidden) return;
    try {
      const r = await fetch(location.href, { headers: { 'X-Fragment': el.id }, credentials: 'same-origin' });
      if (r.redirected || r.status === 401 || r.status === 403 || r.status === 404) { location.reload(); return; }
      if (r.status !== 200) return;
      el.innerHTML = await r.text();
    } catch (e) {}
  }, Number(el.dataset.refresh));
});`;

/** Sin `csrf` en el contexto (el login) no hay barra de navegación. */
export function panelPage(title: string, ctx: PageCtx | { nonce: string }, body: SafeHtml): string {
  const nav = 'csrf' in ctx ? html`<nav>
    <strong>Citara</strong><a href="/panel">Bandeja</a><a href="/panel/auditoria">Auditoría</a><a href="/panel/costos">Costos</a><a href="/panel/estado">Estado</a>
    <form method="post" action="/panel/logout">${csrfField(ctx)}<span class="meta">${ctx.email}</span> <button>Salir</button></form>
  </nav>` : '';
  return html`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Citara</title><style nonce="${ctx.nonce}">${raw(STYLE)}</style></head>
<body>${nav}<main>${body}</main><script nonce="${ctx.nonce}">${raw(REFRESH_SCRIPT)}</script></body></html>`.value;
}
