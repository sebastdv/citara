export type InboundType =
  | 'text' | 'interactive' | 'image' | 'audio' | 'document' | 'video' | 'unsupported';

export interface InboundMessage {
  wamid: string;
  phoneNumberId: string;
  wabaId: string;
  from: string;
  profileName: string | null;
  type: InboundType;
  text: string | null;
  mediaId: string | null;
  timestamp: Date;
  raw: unknown;
}

export interface InboundStatus {
  wamid: string;
  phoneNumberId: string;
  wabaId: string;
  status: string;
  timestamp: Date;
}

/** Mensaje que el negocio envió desde su app de WhatsApp Business (coexistencia). */
export interface PhoneEcho {
  wamid: string;
  phoneNumberId: string;
  wabaId: string;
  /** wa_id del cliente al que le escribió el negocio, sin '+'. */
  to: string;
  type: InboundType;
  text: string | null;
  mediaId: string | null;
  timestamp: Date;
  raw: unknown;
}

export interface HistoryMessage {
  wamid: string;
  /** wa_id de quien lo escribió: el del hilo si fue el cliente. */
  from: string;
  type: InboundType;
  text: string | null;
  mediaId: string | null;
  timestamp: Date;
  raw: unknown;
}

export interface HistoryChunk {
  phoneNumberId: string;
  wabaId: string;
  phase: number | null;
  progress: number | null;
  /** El negocio no aceptó compartir su historial. */
  declined: boolean;
  threads: { waId: string; messages: HistoryMessage[] }[];
}

export interface ContactSync {
  phoneNumberId: string;
  wabaId: string;
  waId: string;
  name: string | null;
  action: 'add' | 'remove';
}

export interface AccountUpdate {
  wabaId: string;
  event: string;
  phoneNumber: string | null;
}
