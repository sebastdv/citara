/**
 * HTML del panel. Toda interpolación se escapa salvo que sea SafeHtml (otro
 * html`` o un raw() puesto a propósito): el panel muestra texto que escriben
 * los clientes, y un olvido aquí es un XSS sobre la sesión del operador.
 */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString() { return this.value; }
}

export type HtmlValue = SafeHtml | string | number | null | undefined | false | HtmlValue[];

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Solo para HTML que arma el propio código, nunca para datos. */
export const raw = (s: string) => new SafeHtml(s);

const render = (v: HtmlValue): string => {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return escapeHtml(String(v));
};

export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0];
  values.forEach((v, i) => { out += render(v) + strings[i + 1]; });
  return new SafeHtml(out);
}
