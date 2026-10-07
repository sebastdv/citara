import { describe, it, expect } from 'vitest';
import type { FlowDefinition } from '@citara/shared';
import { advance } from '../../src/flow-engine/executor';

const flow: FlowDefinition = {
  key: 't', entry: 'cargar',
  steps: {
    cargar: { type: 'tool', tool: 'consultar_disponibilidad', args: { servicio_id: '{{servicio}}' },
              save_list: 'franjas', on_success: 'elegir', on_error: 'fin' },
    elegir: { type: 'pick', text: 'Elige:\n{{franjas}}', from: 'franjas', var: 'franja', next: 'fin' },
    fin: { type: 'end', text: 'Elegiste {{franja_etiqueta}}' },
  },
};
const lista = JSON.stringify([
  { inicio: '2026-09-10T09:00:00-05:00', recurso_id: 'r1', etiqueta: 'jueves 09:00' },
  { inicio: '2026-09-10T09:15:00-05:00', recurso_id: 'r2', etiqueta: 'jueves 09:15' },
]);
const enPick = { stepKey: 'elegir', status: 'active' as const,
                 vars: { __franjas: lista, franjas: '1. jueves 09:00\n2. jueves 09:15' } };

describe('advance — tool y pick', () => {
  it('un paso tool no ejecuta nada: declara la herramienta con sus argumentos interpolados', () => {
    const r = advance(flow, { stepKey: 'cargar', vars: { servicio: 's1' }, status: 'active' }, null);
    expect(r.pending).toEqual({ tool: 'consultar_disponibilidad', args: { servicio_id: 's1' }, stepKey: 'cargar' });
    expect(r.outbound).toEqual([]);
  });

  it('pick sin input muestra la lista', () => {
    expect(advance(flow, enPick, null).outbound).toEqual([{ kind: 'text', body: 'Elige:\n1. jueves 09:00\n2. jueves 09:15' }]);
  });

  it('pick guarda el elegido y cada uno de sus campos', () => {
    const r = advance(flow, enPick, '2');
    expect(r.state.vars).toMatchObject({ franja: '2026-09-10T09:15:00-05:00', franja_recurso_id: 'r2' });
    expect(r.outbound).toEqual([{ kind: 'text', body: 'Elegiste jueves 09:15' }]);
  });

  it('pick con un número fuera de la lista, o con texto, repite la pregunta', () => {
    for (const input of ['3', '0', 'el de las nueve']) {
      const r = advance(flow, enPick, input);
      expect(r.state.stepKey).toBe('elegir');
      expect(r.outbound[0]).toMatchObject({ body: expect.stringContaining('Elige:') });
    }
  });
});
