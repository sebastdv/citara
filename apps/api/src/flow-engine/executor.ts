import type {
  FlowDefinition, FlowStep, SessionState, OutboundContent,
} from '@citara/shared';

const MAX_CHAIN = 20; // pasos encadenados sin input antes de declarar ciclo

export interface ExecResult {
  state: SessionState;
  outbound: OutboundContent[];
}

/** Interpola {{var}} con las variables de sesión; deja intacto lo no resuelto. */
export function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] ?? match);
}

/**
 * Avanza la conversación un turno. Función PURA: no envía, no persiste, no consulta.
 */
export function advance(
  flow: FlowDefinition,
  state: SessionState | null,
  _input: string | null,
): ExecResult {
  let current: SessionState = state ?? { stepKey: flow.entry, vars: {}, status: 'active' };
  const outbound: OutboundContent[] = [];

  for (let hops = 0; ; hops++) {
    if (hops >= MAX_CHAIN) {
      throw new Error(`Ciclo detectado en el flujo '${flow.key}' tras ${MAX_CHAIN} pasos`);
    }

    const step: FlowStep | undefined = flow.steps[current.stepKey];
    if (!step) throw new Error(`Paso inexistente: '${current.stepKey}' en flujo '${flow.key}'`);

    if (step.type === 'message') {
      outbound.push({ kind: 'text', body: interpolate(step.text, current.vars) });
      current = { ...current, stepKey: step.next };
      continue; // encadena sin esperar input
    }

    if (step.type === 'end') {
      if (step.text) outbound.push({ kind: 'text', body: interpolate(step.text, current.vars) });
      return { state: { ...current, status: 'ended' }, outbound };
    }

    // Los demás tipos se implementan en las tareas 12 y 13.
    return { state: current, outbound };
  }
}
