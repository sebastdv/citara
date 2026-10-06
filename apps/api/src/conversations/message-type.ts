import type { OutboundContent } from '@citara/shared';

/** `messages.type` con el vocabulario de Meta, igual que el entrante. */
export function messageTypeOf(content: OutboundContent): 'text' | 'interactive' | 'template' {
  if (content.kind === 'text') return 'text';
  if (content.kind === 'template') return 'template';
  return 'interactive';
}
