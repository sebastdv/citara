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
  status: string;
  timestamp: Date;
}
