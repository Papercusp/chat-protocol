import { parseChatEventV1, type ChatResultBlock } from './protocol-v1.js';

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
/** Pick from the validated block's offered actions, not caller-supplied resource fields. */
export function resultActionIntent(input: unknown, actionId: string): StructuredResultOutcome<ResultActionIntent> {
  const parsed = parseStructuredResults([input]);
  if (!parsed.ok) return parsed;
  const block = parsed.value[0];
  const action = block.actions?.find(action => action.id === actionId);
  return action ? { ok: true, value: { resultId: block.id, actionId: action.id, kind: action.kind, ref: action.ref } }
    : { ok: false, code: 'unavailable' };
}
