import { html } from './html';
import { panelPage } from './layout';

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
