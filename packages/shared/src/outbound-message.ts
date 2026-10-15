export type OutboundContent =
  // essential: el aviso de algo que ya pasó (una cita agendada, movida o cancelada).
  // Sale aunque un humano haya tomado la conversación (ver OutboundProcessor).
  | { kind: 'text'; body: string; essential?: true }
  | { kind: 'buttons'; body: string; buttons: { id: string; title: string }[] }
  | { kind: 'list'; body: string; button: string;
      sections: { title: string; rows: { id: string; title: string; description?: string }[] }[] }
  | { kind: 'template'; name: string; language: string; params: string[] };
