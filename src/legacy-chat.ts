import { parseChatEvent, type ChatEvent } from './index.js';
import { parseChatEnvelope, type ChatEventEnvelope, type ChatEventIdentity,
  type ChatProtocolResult } from './protocol-v1.js';

/** Select at the authenticated host boundary; never guess a dialect from a payload. */
export type LegacyChatDialect = 'scout' | 'papercup';
export interface LegacyChatFrame { eventName: string; data: Record<string, unknown> }

/** Existing Scout shopping events remain the application's own union. */
export function decodeLegacyChatFrame(
  dialect: LegacyChatDialect, eventName: string, data: unknown,
): ChatProtocolResult<ChatEvent> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, code: 'invalid-frame' };
  const body = data as Record<string, unknown>;
  if (body.type !== undefined && body.type !== eventName) return { ok: false, code: 'invalid-frame' };
  if (dialect !== 'scout' && dialect !== 'papercup') return { ok: false, code: 'invalid-frame' };
  if (Object.hasOwn(body, 'schemaVersion')) return { ok: false, code: 'unsupported-version' };
  if (dialect === 'scout' && (eventName === 'delta' || eventName === 'tool_call')) {
    return { ok: false, code: 'unsupported-event' };
  }
  if (dialect === 'scout' && eventName === 'token') {
    return typeof body.content === 'string'
      ? { ok: true, value: { type: 'delta', text: body.content } }
      : { ok: false, code: 'invalid-frame' };
  }
  if (dialect === 'scout' && eventName === 'tool_start') {
    return typeof body.tool === 'string' && body.tool.trim().length > 0
      ? { ok: true, value: { type: 'tool_call', name: body.tool } }
      : { ok: false, code: 'invalid-frame' };
  }
  const event = parseChatEvent(eventName, body);
  return event ? { ok: true, value: event } : { ok: false, code: 'unsupported-event' };
}

/** The host allocates identity. A legacy tool event lacking a stable call ID needs one. */
export function upgradeLegacyChatFrame(
  dialect: LegacyChatDialect, eventName: string, data: unknown,
  identity: ChatEventIdentity, callId?: string,
): ChatProtocolResult<ChatEventEnvelope> {
  const decoded = decodeLegacyChatFrame(dialect, eventName, data);
  if (!decoded.ok) return decoded;
  let event: Record<string, unknown> = { ...decoded.value };
  if (decoded.value.type === 'tool_call' || decoded.value.type === 'tool_result') {
    // Never rewrite a wire call ID: a conflicting host mapping is corrupt identity.
    if (callId && decoded.value.callId && callId !== decoded.value.callId) return { ok: false, code: 'invalid-frame' };
    event.callId = decoded.value.callId ?? callId;
  }
  if (decoded.value.type === 'error') event = { ...event, code: 'legacy-error', retryable: false };
  return parseChatEnvelope({ ...identity, schemaVersion: 1, event });
}

/** Unsupported v1 features are explicit; callers supply a deliberate legacy fallback. */
export function encodeLegacyChatFrame(
  dialect: LegacyChatDialect, envelope: ChatEventEnvelope,
): ChatProtocolResult<LegacyChatFrame> {
  if (dialect !== 'scout' && dialect !== 'papercup') return { ok: false, code: 'invalid-frame' };
  const checked = parseChatEnvelope(envelope);
  if (!checked.ok) return checked;
  const event = checked.value.event;
  if (event.type === 'lifecycle' || event.type === 'result' || event.type === 'capabilities') {
    return { ok: false, code: 'unsupported-event' };
  }
  if (dialect === 'scout' && event.type === 'delta') {
    return { ok: true, value: { eventName: 'token', data: { type: 'token', content: event.text } } };
  }
  if (dialect === 'scout' && event.type === 'tool_call') {
    return { ok: true, value: { eventName: 'tool_start', data: { type: 'tool_start', tool: event.name } } };
  }
  if (event.type === 'error') {
    return { ok: true, value: { eventName: 'error', data: { type: 'error', message: event.message } } };
  }
  return { ok: true, value: { eventName: event.type, data: { ...event } } };
}
