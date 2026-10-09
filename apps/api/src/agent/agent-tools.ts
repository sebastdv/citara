import type Anthropic from '@anthropic-ai/sdk';

type Tool = Anthropic.Beta.Messages.BetaTool;

export const CONTROL_TOOLS = { menu: 'volver_al_menu', human: 'pasar_a_humano' } as const;

const id = (what: string) => ({ type: 'string', description: `Id (uuid) ${what}, tal como lo devolvió otra herramienta.` });
const day = (what: string) => ({ type: 'string', description: `${what} (AAAA-MM-DD, en la zona del negocio).` });
const token = { type: 'string', description: 'El confirmation_token de la llamada anterior. Solo después de que la persona confirme.' };
const object = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object' as const, properties, required, additionalProperties: false });

/**
 * Las herramientas que ve el modelo. Son las de la agenda (validadas otra vez
 * por el registro, R1) y dos de control. El orden es FIJO y alfabético: es
 * parte del prefijo cacheado y del que firman los bloques de pensamiento.
 */
export const AGENT_TOOLS: Tool[] = [
  {
    name: 'agendar_cita',
    description: 'Reserva una cita. Sin confirmation_token, revisa el horario y devuelve un token: cuéntale a la persona la cita y pregúntale si confirma. Cuando confirme en su siguiente mensaje, llama otra vez con los mismos datos y el token.',
    input_schema: object({
      servicio_id: id('del servicio'), recurso_id: id('de quien atiende'),
      inicio: { type: 'string', description: 'Inicio ISO-8601 con offset, tal como lo devolvió consultar_disponibilidad.' },
      nombre: { type: 'string', description: 'Nombre de la persona para la cita.' },
      notas: { type: 'string' }, confirmation_token: token,
    }, ['servicio_id', 'recurso_id', 'inicio', 'nombre']),
  },
  {
    name: 'cancelar_cita',
    description: 'Cancela una cita de la persona. Sin confirmation_token devuelve un token; con el token, tras su confirmación, la cancela.',
    input_schema: object({ cita_id: id('de la cita'), confirmation_token: token, motivo: { type: 'string' } }, ['cita_id']),
  },
  {
    name: 'consultar_dias',
    description: 'Próximos días con horarios libres para un servicio.',
    input_schema: object({ servicio_id: id('del servicio'), recurso_id: id('de quien atiende (opcional)'),
                           dias: { type: 'integer', minimum: 1, maximum: 14 } }, ['servicio_id']),
  },
  {
    name: 'consultar_disponibilidad',
    description: 'Horarios libres de un servicio entre dos días. Devuelve el inicio exacto (con offset) y quién atiende: úsalos tal cual para agendar.',
    input_schema: object({ servicio_id: id('del servicio'), recurso_id: id('de quien atiende (opcional)'),
                           desde: day('Desde'), hasta: day('Hasta'),
                           limite: { type: 'integer', minimum: 1, maximum: 50 },
                           espaciado_min: { type: 'integer', minimum: 0, maximum: 240,
                                            description: 'Minutos mínimos entre dos horas ofrecidas.' } },
                         ['servicio_id']),
  },
  {
    name: 'consultar_mis_citas',
    description: 'Las próximas citas confirmadas de quien escribe, con su id.',
    input_schema: object({}),
  },
  {
    name: 'consultar_servicios',
    description: 'Los servicios del negocio con su id, duración y precio.',
    input_schema: object({}),
  },
  {
    name: 'reprogramar_cita',
    description: 'Mueve una cita de la persona a otro horario. Sin confirmation_token revisa el horario y devuelve un token; con el token, tras su confirmación, la mueve.',
    input_schema: object({ cita_id: id('de la cita'),
                           nuevo_inicio: { type: 'string', description: 'Nuevo inicio ISO-8601 con offset.' },
                           confirmation_token: token }, ['cita_id', 'nuevo_inicio']),
  },
  {
    name: CONTROL_TOOLS.human,
    description: 'Pasa la conversación a una persona del equipo del negocio.',
    input_schema: object({ motivo: { type: 'string' } }, ['motivo']),
  },
  {
    name: CONTROL_TOOLS.menu,
    description: 'Termina tu parte: la persona verá el menú del negocio.',
    input_schema: object({}),
  },
];
