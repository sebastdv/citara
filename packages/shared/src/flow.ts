export type FlowStep =
  | { type: 'message'; text: string; next: string }
  | { type: 'choice'; text: string; kind?: 'interactive_buttons' | 'interactive_list';
      buttons: { id: string; title: string; next: string }[]; ai_fallback?: boolean }
  | { type: 'capture'; text: string; var: string; validate?: 'text' | 'number' | 'email';
      next: string; on_invalid?: string }
  | { type: 'handoff'; text: string }
  | { type: 'end'; text?: string };

export interface FlowDefinition {
  key: string;
  entry: string;
  steps: Record<string, FlowStep>;
}

export interface SessionState {
  stepKey: string;
  vars: Record<string, string>;
  status: 'active' | 'handoff' | 'ended';
}
