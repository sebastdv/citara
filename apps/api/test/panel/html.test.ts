import { describe, it, expect } from 'vitest';
import { html, raw, SafeHtml } from '../../src/panel/html';
import { panelPage, newNonce } from '../../src/panel/layout';

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
