import { describe, it, expect } from 'vitest';
import { advance } from '../../src/flow-engine/executor';
import type { FlowDefinition } from '@citara/shared';

const flow: FlowDefinition = {
  key: 'menu', entry: 'menu',
  steps: {
    menu: {
      type: 'choice',
      kind: 'interactive_buttons',
      text: '¿En qué te ayudo?',
      buttons: [
        { id: 'agendar', title: 'Agendar cita', next: 'ok_agendar' },
        { id: 'citas',   title: 'Mis citas',    next: 'ok_citas' },
      ],
    },
    ok_agendar: { type: 'end', text: 'Vamos a agendar.' },
    ok_citas:   { type: 'end', text: 'Estas son tus citas.' },
  },
};

const inMenu = { stepKey: 'menu', vars: {}, status: 'active' as const };

describe('advance — choice', () => {
  it('al llegar al paso emite el menú como botones interactivos', () => {
    const res = advance(flow, null, null);
    expect(res.outbound).toEqual([{
      kind: 'buttons', body: '¿En qué te ayudo?',
      buttons: [
        { id: 'agendar', title: 'Agendar cita' },
        { id: 'citas',   title: 'Mis citas' },
      ],
    }]);
    expect(res.state.stepKey).toBe('menu');
    expect(res.state.status).toBe('active');
  });

  it('ramifica por el id del botón', () => {
    const res = advance(flow, inMenu, 'agendar');
    expect(res.outbound).toEqual([{ kind: 'text', body: 'Vamos a agendar.' }]);
    expect(res.state.status).toBe('ended');
  });

  it('ramifica por el título exacto, ignorando mayúsculas y espacios', () => {
    const res = advance(flow, inMenu, '  MIS CITAS  ');
    expect(res.outbound).toEqual([{ kind: 'text', body: 'Estas son tus citas.' }]);
  });

  it('ramifica por posición numérica (degradación a texto numerado)', () => {
    const res = advance(flow, inMenu, '2');
    expect(res.outbound).toEqual([{ kind: 'text', body: 'Estas son tus citas.' }]);
  });

  it('ante una entrada que no coincide, repite el menú sin avanzar', () => {
    const res = advance(flow, inMenu, 'quiero un helado');
    expect(res.state.stepKey).toBe('menu');
    expect(res.state.status).toBe('active');
    expect(res.outbound[0].kind).toBe('buttons');
  });

  it('un número fuera de rango no avanza', () => {
    const res = advance(flow, inMenu, '9');
    expect(res.state.stepKey).toBe('menu');
  });

  it('emite lista interactiva cuando kind es interactive_list', () => {
    const lista: FlowDefinition = {
      key: 'l', entry: 'sel',
      steps: {
        sel: {
          type: 'choice', kind: 'interactive_list', text: 'Elige servicio',
          buttons: [{ id: 'corte', title: 'Corte', next: 'f' }],
        },
        f: { type: 'end' },
      },
    };
    const res = advance(lista, null, null);
    expect(res.outbound[0]).toMatchObject({
      kind: 'list', body: 'Elige servicio',
      sections: [{ title: 'Opciones', rows: [{ id: 'corte', title: 'Corte' }] }],
    });
  });
});
