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

describe('advance con IA', () => {
  const flow: FlowDefinition = {
    key: 'f', entry: 'menu', ai_step: 'asistente',
    steps: {
      menu: { type: 'choice', text: '¿Qué necesitas?', buttons: [{ id: 'a', title: 'Agendar', next: 'fin' }] },
      estricto: { type: 'choice', text: 'Elige', ai_fallback: false, buttons: [{ id: 'a', title: 'A', next: 'fin' }] },
      asistente: { type: 'ai_turn', next: 'menu', text_unavailable: 'Ahora te atiendo con el menú.' },
      fin: { type: 'end', text: 'listo' },
    },
  };
  const at = (stepKey: string) => ({ stepKey, vars: {}, status: 'active' as const });

  it('lo que no encaja en un menú se pide interpretar, sin repetir el menú', () => {
    expect(advance(flow, at('menu'), 'quiero ver mis citas', { ai: true }))
      .toMatchObject({ outbound: [], ai: { kind: 'interpret', stepKey: 'menu', input: 'quiero ver mis citas' } });
  });

  it('sin IA, o con ai_fallback: false, el menú se repite como siempre', () => {
    expect(advance(flow, at('menu'), 'xyz').ai).toBeUndefined();
    expect(advance(flow, at('estricto'), 'xyz', { ai: true }).ai).toBeUndefined();
    expect(advance(flow, at('estricto'), 'xyz', { ai: true }).outbound[0]).toMatchObject({ kind: 'buttons' });
  });

  it('el paso ai_turn deriva al agente con IA, y sin IA se salta avisando si la persona venía hablando', () => {
    expect(advance(flow, at('asistente'), 'hola', { ai: true })).toMatchObject({ outbound: [], ai: { kind: 'agent', stepKey: 'asistente' } });
    const sinIa = advance(flow, at('asistente'), 'hola');
    expect(sinIa.outbound.map((o) => ('body' in o ? o.body : ''))).toEqual(['Ahora te atiendo con el menú.', '¿Qué necesitas?']);
    expect(sinIa.state.stepKey).toBe('menu');
  });
});
