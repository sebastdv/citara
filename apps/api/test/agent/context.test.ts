import { describe, it, expect } from 'vitest';
import { AGENT_TOOLS, CONTROL_TOOLS } from '../../src/agent/agent-tools';
import { buildSystem, userTurn } from '../../src/agent/context';
import { buildScheduling } from '../helpers';

const facts = { name: 'Salón X', timezone: 'America/Bogota',
  services: [{ nombre: 'Corte de cabello', duracion_min: 30, precio_centavos: 3_500_000 }], resources: ['María'] };
const config = { version: 1, enabled: true, model: 'claude-opus-5-5', effort: 'low', interpreterModel: 'claude-haiku-5-5',
                 instructions: 'Hay estacionamiento en la esquina.', monthlyBudgetUsd: 20 };

describe('contexto del agente', () => {
  it('las herramientas del agente son las de la agenda más las de control, en orden fijo', () => {
    const agenda = Object.keys(buildScheduling().tools.tools).sort();
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual([...agenda, CONTROL_TOOLS.human, CONTROL_TOOLS.menu]);
  });

  it('el system lleva el negocio, sus servicios y las instrucciones, sin nada volátil', () => {
    const system = buildSystem(facts, config);
    expect(system).toContain('Salón X');
    expect(system).toContain('Corte de cabello (30 min, $35.000)');
    expect(system).toContain('Hay estacionamiento en la esquina.');
    expect(system).not.toMatch(/2026|hoy es/i);
    expect(buildSystem(facts, config)).toBe(system);
  });

  it('la fecha y la hora van en el turno del usuario, con lo que escribió la persona', () => {
    const turn = userTurn(new Date('2026-09-08T15:00:00Z'), 'America/Bogota', ['Hola', 'quiero un corte']);
    const text = (turn.content as { type: string; text: string }[]).map((b) => b.text).join('\n');
    expect(text).toMatch(/^Ahora: martes 8 de septiembre.*10:00/m);
    expect(text).toContain('Hola\nquiero un corte');
  });
});
