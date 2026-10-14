import { describe, it, expect } from 'vitest';
import { html, raw, SafeHtml } from '../../src/panel/html';
import { runInNewContext } from 'node:vm';
import { panelPage, newNonce, REFRESH_SCRIPT } from '../../src/panel/layout';

describe('html``', () => {
  it('escapa toda interpolación', () => {
    const evil = `"><script>alert(1)</script>'&`;
    const esc = '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&#39;&amp;';
    expect(html`<p title="${evil}">${evil}</p>`.value).toBe(`<p title="${esc}">${esc}</p>`);
  });
  it('no escapa lo marcado raw() ni lo que ya es SafeHtml, y aplana listas', () => {
    const items = ['<a>', '<b>'].map((x) => html`<li>${x}</li>`);
    expect(html`<ul>${items}</ul>${raw('<hr>')}`.value).toBe('<ul><li>&lt;a&gt;</li><li>&lt;b&gt;</li></ul><hr>');
  });
  it('null, undefined y false no imprimen nada; los números sí', () => {
    expect(html`${null}${undefined}${false}${0}`.value).toBe('0');
  });
  it('el resultado es SafeHtml y un string interpolado nunca pasa sin escapar', () => {
    expect(html`${'x'}`).toBeInstanceOf(SafeHtml);
    expect(html`${'<i>'}`.value).toBe('&lt;i&gt;');
  });
});

describe('panelPage', () => {
  it('pone el nonce en el style y el script, escapa el título y lleva la barra', () => {
    const nonce = newNonce();
    const page = panelPage('<x>', { nonce, csrf: 'c', email: 'op@citara.co' }, html`<p>hola</p>`);
    expect(page).toContain(`<style nonce="${nonce}">`);
    expect(page).toContain(`<script nonce="${nonce}">`);
    expect(page).toContain('<title>&lt;x&gt; · Citara</title>');
    expect(page).toContain('<nav>');
    expect(page).not.toMatch(/<script(?! nonce)/);
  });
  it('sin sesión (login) no lleva barra de navegación', () => {
    expect(panelPage('Entrar', { nonce: newNonce() }, html`<p>x</p>`)).not.toContain('<nav>');
  });
});

describe('script de refresco', () => {
  /** Corre el script con un DOM mínimo y devuelve el tick del intervalo y lo que pasó. */
  function harness(response: () => Promise<{ status: number; redirected: boolean; text: () => Promise<string> }>) {
    const el = { id: 'mensajes', dataset: { refresh: '5000' }, innerHTML: 'viejo' };
    const state = { reloads: 0, tick: null as null | (() => Promise<void>) };
    const sandbox = {
      document: { hidden: false, querySelectorAll: () => [el] },
      location: { href: 'http://localhost/panel/x', reload: () => { state.reloads++; } },
      fetch: response,
      setInterval: (fn: () => Promise<void>) => { state.tick = fn; },
      Number,
    };
    runInNewContext(REFRESH_SCRIPT, sandbox);
    return { el, state };
  }
  const ok = (body: string) => async () => ({ status: 200, redirected: false, text: async () => body });

  it('con 200 reemplaza solo el fragmento', async () => {
    const { el, state } = harness(ok('nuevo'));
    await state.tick!();
    expect([el.innerHTML, state.reloads]).toEqual(['nuevo', 0]);
  });
  it('si la sesión venció (redirección al login, 401/403) recarga la página entera', async () => {
    for (const r of [{ status: 200, redirected: true }, { status: 403, redirected: false }, { status: 401, redirected: false }]) {
      const { el, state } = harness(async () => ({ ...r, text: async () => '<form action="/panel/login">' }));
      await state.tick!();
      expect([el.innerHTML, state.reloads]).toEqual(['viejo', 1]);
    }
  });
  it('un 5xx pasajero o un error de red no recargan: el borrador sobrevive a un despliegue', async () => {
    for (const fetchFn of [async () => ({ status: 502, redirected: false, text: async () => 'Bad Gateway' }),
                           async () => { throw new Error('red caída'); }]) {
      const { el, state } = harness(fetchFn as never);
      await state.tick!();
      expect([el.innerHTML, state.reloads]).toEqual(['viejo', 0]);
    }
  });
});
