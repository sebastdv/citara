import type { FlowDefinition } from '@citara/shared';

/** El flujo de menús que se entrega a cada negocio (`tenant:apply` con `flow: agenda`). */
export const AGENDA_FLOW: FlowDefinition = {
  key: 'agenda',
  entry: 'saludo',
  steps: {
    saludo: { type: 'message', text: '¡Hola! Soy el asistente de citas 👋', next: 'menu' },
    menu: {
      type: 'choice', kind: 'interactive_buttons', text: '¿Qué necesitas?',
      buttons: [
        { id: 'agendar', title: 'Agendar cita', next: 'cargar_servicios' },
        { id: 'mis_citas', title: 'Mis citas', next: 'cargar_citas' },
        { id: 'asesor', title: 'Hablar con alguien', next: 'humano' },
      ],
    },
    cargar_servicios: {
      type: 'tool', tool: 'consultar_servicios', args: {},
      save_list: 'servicios', render: '{{nombre}} ({{duracion_min}} min)',
      on_success: 'elegir_servicio', on_empty: 'sin_servicios', on_error: 'error',
    },
    elegir_servicio: {
      type: 'pick', text: '¿Qué servicio necesitas? Responde con el número.\n{{servicios}}',
      from: 'servicios', var: 'servicio', next: 'cargar_franjas',
    },
    cargar_franjas: {
      type: 'tool', tool: 'consultar_disponibilidad', args: { servicio_id: '{{servicio}}', limite: '9' },
      save_list: 'franjas', render: '{{etiqueta}} con {{recurso}}',
      on_success: 'elegir_franja', on_empty: 'sin_franjas', on_error: 'error',
    },
    elegir_franja: {
      type: 'pick', text: 'Estos son los próximos horarios. Responde con el número.\n{{franjas}}',
      from: 'franjas', var: 'franja', next: 'pide_nombre',
    },
    pide_nombre: { type: 'capture', text: '¿A nombre de quién agendo la cita?', var: 'nombre', validate: 'text', next: 'reservar' },
    reservar: {
      type: 'tool', tool: 'agendar_cita',
      args: { servicio_id: '{{servicio}}', recurso_id: '{{franja_recurso_id}}', inicio: '{{franja_inicio}}', nombre: '{{nombre}}' },
      on_success: 'confirmada', on_error: 'ocupada',
    },
    confirmada: { type: 'end', text: '¡Listo, {{nombre}}! Tu cita quedó para el {{franja_etiqueta}} con {{franja_recurso}}.' },
    ocupada: { type: 'end', text: 'Ese horario se acaba de ocupar. Escríbenos de nuevo y te muestro otros.' },
    cargar_citas: {
      type: 'tool', tool: 'consultar_mis_citas', args: {},
      save_list: 'citas', render: '{{etiqueta}} — {{servicio}} con {{recurso}}',
      on_success: 'mostrar_citas', on_empty: 'sin_citas', on_error: 'error',
    },
    mostrar_citas: { type: 'end', text: 'Tus próximas citas:\n{{citas}}' },
    sin_citas: { type: 'end', text: 'No tienes citas próximas.' },
    sin_servicios: { type: 'end', text: 'Por ahora no hay servicios para agendar.' },
    sin_franjas: { type: 'end', text: 'No encontré horarios libres en los próximos días. Escríbenos y te ayudamos.' },
    humano: { type: 'handoff', text: 'Te comunico con alguien del equipo.' },
    error: { type: 'end', text: 'Tuvimos un problema. Intenta de nuevo más tarde.' },
  },
};
