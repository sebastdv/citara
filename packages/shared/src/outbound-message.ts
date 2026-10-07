export type OutboundContent =
  | { kind: 'text'; body: string }
  | { kind: 'buttons'; body: string; buttons: { id: string; title: string }[] }
  | { kind: 'list'; body: string; button: string;
      sections: { title: string; rows: { id: string; title: string; description?: string }[] }[] }
  | { kind: 'template'; name: string; language: string; params: string[] };
