import { parseChatEnvelope, parseChatEventV1, type ChatResultBlock } from './protocol-v1.js';

export type StructuredResultFailure = 'invalid' | 'unsupported' | 'unavailable' | 'unauthorized' | 'stale';
export type StructuredResultOutcome<T> = { ok: true; value: T } | { ok: false; code: StructuredResultFailure };
/** An intent is never a credential, URL, tool call, or permission to dispatch. */
export interface ResultActionIntent {
  resultId: string;
  actionId: string;
  kind: string;
  ref: string;
}
/** Canonical wire parser plus collection identity checks. Returned refs remain opaque. */
export function parseStructuredResults(input: unknown): StructuredResultOutcome<ChatResultBlock[]> {
  const parsed = parseChatEventV1({ type: 'result', blocks: input });
  if (!parsed || parsed.type !== 'result') return { ok: false, code: 'invalid' };
  const ids = new Set<string>();
  for (const block of parsed.blocks) {
    if (ids.has(block.id)) return { ok: false, code: 'invalid' };
    ids.add(block.id);
  }
  return { ok: true, value: parsed.blocks };
}

/** Rebuild the result view from the host's durable event log, preserving its turn fence.
 * No resolution or activation occurs here; a renderer still requires current host authorization. */
export function collectTurnResults(events: unknown, identity: { conversationId: string; turnId: string }):
StructuredResultOutcome<ChatResultBlock[]> {
  if (!Array.isArray(events)) return { ok: false, code: 'invalid' };
  const blocks = new Map<string, ChatResultBlock>();
  const eventIds = new Set<string>();
  let sequence: number | undefined;
  for (const input of events) {
    const parsed = parseChatEnvelope(input);
    if (!parsed.ok || parsed.value.conversationId !== identity.conversationId
      || parsed.value.turnId !== identity.turnId || eventIds.has(parsed.value.eventId)
      || (sequence !== undefined && parsed.value.sequence !== sequence + 1)) return { ok: false, code: 'invalid' };
    sequence = parsed.value.sequence;
    eventIds.add(parsed.value.eventId);
    if (parsed.value.event.type === 'result') {
      const results = parseStructuredResults(parsed.value.event.blocks);
      if (!results.ok) return results;
      for (const block of results.value) blocks.set(block.id, block);
    }
  }
  return { ok: true, value: [...blocks.values()] };
}
/** Pick from the validated block's offered actions, not caller-supplied resource fields. */
export function resultActionIntent(input: unknown, actionId: string): StructuredResultOutcome<ResultActionIntent> {
  const parsed = parseStructuredResults([input]);
  if (!parsed.ok) return parsed;
  const block = parsed.value[0];
  const action = block.actions?.find(action => action.id === actionId);
  return action ? { ok: true, value: { resultId: block.id, actionId: action.id, kind: action.kind, ref: action.ref } }
    : { ok: false, code: 'unavailable' };
}
