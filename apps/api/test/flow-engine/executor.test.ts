import { describe, it, expect } from 'vitest';
import { advance } from '../../src/flow-engine/executor';
import type { FlowDefinition } from '@citara/shared';

const flow: FlowDefinition = {
  key: 'demo',
  entry: 'saludo',
  steps: {
    saludo: { type: 'message', text: '¡Hola! Soy el asistente.', next: 'despedida' },
    despedida: { type: 'end', text: 'Hasta luego.' },
  },
};

describe('advance — message y end', () => {
  it('sin estado previo arranca en el paso de entrada y emite su mensaje', () => {
    const res = advance(flow, null, null);
    // El primer mensaje es el del paso de entrada. Que haya más se comprueba
    // en el test siguiente: message encadena con el paso que le sigue.
    expect(res.outbound[0]).toEqual({ kind: 'text', body: '¡Hola! Soy el asistente.' });
  });

  it('encadena message → end en un solo turno, emitiendo ambos textos', () => {
    const res = advance(flow, null, null);
    expect(res.outbound).toHaveLength(2);
    expect(res.outbound[1]).toEqual({ kind: 'text', body: 'Hasta luego.' });
    expect(res.state.status).toBe('ended');
  });

  it('un end sin texto no emite mensaje pero sí cierra la sesión', () => {
    const silencioso: FlowDefinition = {
      key: 'x', entry: 'fin', steps: { fin: { type: 'end' } },
    };
    const res = advance(silencioso, null, null);
    expect(res.outbound).toEqual([]);
    expect(res.state.status).toBe('ended');
  });

  it('conserva las variables de la sesión al avanzar', () => {
    const state = { stepKey: 'saludo', vars: { nombre: 'Ana' }, status: 'active' as const };
    const res = advance(flow, state, 'lo que sea');
    expect(res.state.vars).toEqual({ nombre: 'Ana' });
  });

  it('interpola variables en el texto del mensaje', () => {
    const saludo: FlowDefinition = {
      key: 'x', entry: 'hola',
      steps: { hola: { type: 'message', text: 'Hola {{nombre}}', next: 'f' },
               f: { type: 'end' } },
    };
    const state = { stepKey: 'hola', vars: { nombre: 'Ana' }, status: 'active' as const };
    const res = advance(saludo, state, null);
    expect(res.outbound[0]).toEqual({ kind: 'text', body: 'Hola Ana' });
  });

  it('deja el placeholder intacto si la variable no existe', () => {
    const saludo: FlowDefinition = {
      key: 'x', entry: 'hola',
      steps: { hola: { type: 'message', text: 'Hola {{nombre}}', next: 'f' },
               f: { type: 'end' } },
    };
    const res = advance(saludo, { stepKey: 'hola', vars: {}, status: 'active' }, null);
    expect(res.outbound[0]).toEqual({ kind: 'text', body: 'Hola {{nombre}}' });
  });

  it('corta un ciclo infinito de mensajes encadenados', () => {
    const ciclo: FlowDefinition = {
      key: 'x', entry: 'a',
      steps: { a: { type: 'message', text: 'A', next: 'b' },
               b: { type: 'message', text: 'B', next: 'a' } },
    };
    expect(() => advance(ciclo, null, null)).toThrow(/ciclo/i);
  });
});
