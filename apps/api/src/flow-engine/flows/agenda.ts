import type { FlowDefinition } from '@citara/shared';

/** El flujo de menús que se entrega a cada negocio (`tenant:apply` con `flow: agenda`). */
export const AGENDA_FLOW: FlowDefinition = {
  key: 'agenda',
  entry: 'saludo',
  ai_step: 'asistente',
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
      from: 'servicios', var: 'servicio', next: 'cargar_dias',
    },
    cargar_dias: {
      type: 'tool', tool: 'consultar_dias', args: { servicio_id: '{{servicio}}' },
      save_list: 'dias', render: '{{etiqueta}}',
      on_success: 'elegir_dia', on_empty: 'sin_franjas', on_error: 'error',
    },
    elegir_dia: {
      type: 'pick', text: '¿Qué día te queda bien? Responde con el número.\n{{dias}}',
      from: 'dias', var: 'dia', next: 'cargar_franjas',
    },
    // Horas repartidas por todo el día elegido, no solo las primeras de la mañana.
    cargar_franjas: {
      type: 'tool', tool: 'consultar_disponibilidad',
      args: { servicio_id: '{{servicio}}', desde: '{{dia_fecha}}', hasta: '{{dia_fecha}}', espaciado_min: '60', limite: '10' },
      save_list: 'franjas', render: '{{hora}} con {{recurso}}',
      on_success: 'elegir_franja', on_empty: 'dia_sin_franjas', on_error: 'error',
    },
    elegir_franja: {
      type: 'pick', text: 'Estos son los horarios del {{dia_etiqueta}}. Responde con el número.\n{{franjas}}',
      from: 'franjas', var: 'franja', next: 'pide_nombre',
    },
    dia_sin_franjas: { type: 'message', text: 'Ese día ya no tiene horarios libres.', next: 'cargar_dias' },
    pide_nombre: { type: 'capture', text: '¿A nombre de quién agendo la cita?', var: 'nombre', validate: 'text', next: 'reservar' },
    reservar: {
      type: 'tool', tool: 'agendar_cita',
      args: { servicio_id: '{{servicio}}', recurso_id: '{{franja_recurso_id}}', inicio: '{{franja_inicio}}', nombre: '{{nombre}}' },
      on_success: 'confirmada', on_error: 'no_se_pudo',
    },
    confirmada: { type: 'end', text: '¡Listo, {{nombre}}! Tu cita quedó para el {{franja_etiqueta}} con {{franja_recurso}}.' },
    // Cualquier motivo (se ocupó, ya no hay anticipación suficiente...) se
    // explica y se vuelven a ofrecer las horas del día, en vez de cerrar.
    no_se_pudo: { type: 'message', text: 'No pude agendar ese horario: {{__tool_error}}.', next: 'cargar_franjas' },
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
    // Spec §1, conversación híbrida: aquí conversa el agente. Sin IA, se salta al menú.
    asistente: { type: 'ai_turn', next: 'menu', text_unavailable: 'Ahora mismo te atiendo con el menú.' },
    error: { type: 'end', text: 'Tuvimos un problema. Intenta de nuevo más tarde.' },
  },
};
