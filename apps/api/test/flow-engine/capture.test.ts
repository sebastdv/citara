import { describe, it, expect } from 'vitest';
import { advance } from '../../src/flow-engine/executor';
import { validateInput } from '../../src/flow-engine/validators';
import type { FlowDefinition } from '@citara/shared';

const flow: FlowDefinition = {
  key: 'reg', entry: 'pide_nombre',
  steps: {
    pide_nombre: {
      type: 'capture', text: '¿Cuál es tu nombre?', var: 'nombre',
      validate: 'text', next: 'saluda', on_invalid: 'nombre_invalido',
    },
    saluda: { type: 'end', text: 'Gracias, {{nombre}}.' },
    nombre_invalido: { type: 'end', text: 'Nombre no válido.' },
  },
};

const enPaso = { stepKey: 'pide_nombre', vars: {}, status: 'active' as const };

describe('validateInput', () => {
  it('acepta texto no vacío', () => {
    expect(validateInput('text', 'Ana')).toEqual({ ok: true, value: 'Ana' });
  });
  it('rechaza texto vacío o solo espacios', () => {
    expect(validateInput('text', '   ').ok).toBe(false);
  });
  it('acepta un número y lo normaliza sin espacios', () => {
    expect(validateInput('number', ' 42 ')).toEqual({ ok: true, value: '42' });
  });
  it('rechaza un número con letras', () => {
    expect(validateInput('number', '4a2').ok).toBe(false);
  });
  it('acepta un email válido', () => {
    expect(validateInput('email', 'a@b.co')).toEqual({ ok: true, value: 'a@b.co' });
  });
  it('rechaza un email sin dominio', () => {
    expect(validateInput('email', 'a@').ok).toBe(false);
  });
  it('recorta el email a minúsculas', () => {
    expect(validateInput('email', ' A@B.CO ')).toEqual({ ok: true, value: 'a@b.co' });
  });
});

describe('advance — capture', () => {
  it('al llegar al paso pide el dato y espera', () => {
    const res = advance(flow, null, null);
    expect(res.outbound).toEqual([{ kind: 'text', body: '¿Cuál es tu nombre?' }]);
    expect(res.state.stepKey).toBe('pide_nombre');
  });

  it('guarda el valor válido en las variables y avanza', () => {
    const res = advance(flow, enPaso, 'Ana');
    expect(res.state.vars).toEqual({ nombre: 'Ana' });
    expect(res.outbound).toEqual([{ kind: 'text', body: 'Gracias, Ana.' }]);
    expect(res.state.status).toBe('ended');
  });

  it('ante un valor inválido salta a on_invalid', () => {
    const res = advance(flow, enPaso, '   ');
    expect(res.outbound).toEqual([{ kind: 'text', body: 'Nombre no válido.' }]);
  });

  it('sin on_invalid, repite la pregunta sin avanzar', () => {
    const sinSalida: FlowDefinition = {
      key: 'x', entry: 'p',
      steps: { p: { type: 'capture', text: 'Dato?', var: 'd', validate: 'number', next: 'f' },
               f: { type: 'end' } },
    };
    const res = advance(sinSalida, { stepKey: 'p', vars: {}, status: 'active' }, 'abc');
    expect(res.state.stepKey).toBe('p');
    expect(res.outbound).toEqual([{ kind: 'text', body: 'Dato?' }]);
  });

  it('no pisa variables previas al capturar una nueva', () => {
    const res = advance(flow, { stepKey: 'pide_nombre', vars: { previa: 'x' }, status: 'active' }, 'Ana');
    expect(res.state.vars).toEqual({ previa: 'x', nombre: 'Ana' });
  });
});
