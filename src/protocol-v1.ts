import { parseChatEvent, type ChatEvent } from './index.js';

/** Legacy payloads are version 0 ONLY at an explicitly selected host adapter. */
export const CHAT_PROTOCOL_VERSION = 1 as const;
export const CHAT_STATE_VERSION = 1 as const;
export const SUPPORTED_CHAT_VERSIONS = [0, 1] as const;
export type ChatWireVersion = (typeof SUPPORTED_CHAT_VERSIONS)[number];

export const RECOVERY_CAPABILITY_KEYS = [
  'connectionReplay', 'persistedHistory', 'persistedInteractionDecisions',
  'completedToolCheckpoints', 'interruptedTurnRecovery',
] as const;
export type RecoveryCapability = (typeof RECOVERY_CAPABILITY_KEYS)[number];
/** Declarations are independent. A history reader does not imply resumable execution. */
export type ChatRecoveryCapabilities = Record<RecoveryCapability, boolean>;

export type ChatTurnPhase = 'running' | 'awaiting-input' | 'completed' | 'failed'
  | 'cancelled' | 'interrupted' | 'needs-reconciliation';
export const CHAT_TURN_PHASES: readonly ChatTurnPhase[] = [
  'running', 'awaiting-input', 'completed', 'failed', 'cancelled', 'interrupted', 'needs-reconciliation',
];
export const CHAT_ERROR_CODES = [
  'unsupported-version', 'invalid-frame', 'unauthorized', 'storage-unavailable',
  'provider-failure', 'deadline-exceeded', 'replay-expired', 'effect-unknown', 'legacy-error',
] as const;
export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[number];

/** Opaque refs are resolved and authorized by the host, never by the renderer. */
export interface ChatResultBlock {
  id: string;
  kind: 'entity' | 'document' | 'report' | 'task' | 'suggestion';
  title: string;
  text?: string;
  sources: Array<{ ref: string; label?: string }>;
}

type CommonEvent = Exclude<ChatEvent, { type: 'tool_call' | 'tool_result' | 'error' }>;
export type ChatEventV1 = CommonEvent
  | { type: 'tool_call'; name: string; callId: string; input?: unknown }
  | { type: 'tool_result'; name: string; callId: string; ok: boolean; summary?: string }
  | { type: 'error'; code: ChatErrorCode; message: string; retryable: boolean }
  | { type: 'lifecycle'; phase: ChatTurnPhase }
  | { type: 'result'; blocks: ChatResultBlock[] }
  | { type: 'capabilities'; capabilities: ChatRecoveryCapabilities };

export type ChatEventChannel = 'event' | 'state' | 'transient';
const V1_CHANNELS = {
  session: 'event', delta: 'event', tool_call: 'event', tool_result: 'event', provenance: 'event',
  done: 'event', error: 'event', lifecycle: 'event', result: 'event',
  card: 'state', card_closed: 'state', state: 'state', capabilities: 'state', navigate: 'transient',
} as const satisfies Record<ChatEventV1['type'], ChatEventChannel>;

/** Persist/replay only event-channel entries; re-send current state separately. */
export function chatEventChannel(type: ChatEventV1['type']): ChatEventChannel {
  return V1_CHANNELS[type];
}

export interface ChatEventIdentity {
  conversationId: string;
  turnId: string;
  eventId: string;
  /** Positive, safe integer, monotonic within a turn; allocated by the server store. */
  sequence: number;
}
export interface ChatEventEnvelope extends ChatEventIdentity {
  schemaVersion: typeof CHAT_PROTOCOL_VERSION;
  event: ChatEventV1;
}

/** Persist this alongside the host's existing conversation state, not in a parallel store. */
export interface ChatStateV1 {
  schemaVersion: typeof CHAT_STATE_VERSION;
  conversationId: string;
  turnId: string;
  /** Compare-and-swap revision for the host's durable mutation. */
  revision: number;
  phase: ChatTurnPhase;
  lastSequence: number;
  capabilities: ChatRecoveryCapabilities;
}

export type ChatProtocolResult<T> = { ok: true; value: T }
  | { ok: false; code: 'unsupported-version' | 'invalid-frame' | 'unsupported-event' | 'unsupported-capability' };
const invalid = (): ChatProtocolResult<never> => ({ ok: false, code: 'invalid-frame' });
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value;
const counter = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** No default: omitted/invalid/future versions cannot accidentally create a v1 turn. */
export function negotiateChatVersion(version: unknown): ChatProtocolResult<ChatWireVersion> {
  return version === 0 || version === 1
    ? { ok: true, value: version }
    : { ok: false, code: 'unsupported-version' };
}

export function parseRecoveryCapabilities(value: unknown): ChatRecoveryCapabilities | null {
  if (!object(value) || RECOVERY_CAPABILITY_KEYS.some((key) => typeof value[key] !== 'boolean')) return null;
  return Object.fromEntries(RECOVERY_CAPABILITY_KEYS.map((key) => [key, value[key]])) as ChatRecoveryCapabilities;
}

export function requireChatCapabilities(
  available: ChatRecoveryCapabilities, required: readonly RecoveryCapability[],
): ChatProtocolResult<ChatRecoveryCapabilities> {
  const parsed = parseRecoveryCapabilities(available);
  if (!parsed) return invalid();
  return required.every((key) => parsed[key] === true)
    ? { ok: true, value: parsed }
    : { ok: false, code: 'unsupported-capability' };
}

function parseResultBlock(value: unknown): ChatResultBlock | null {
  if (!object(value) || !id(value.id) || !id(value.title)
    || !['entity', 'document', 'report', 'task', 'suggestion'].includes(String(value.kind))
    || (value.text !== undefined && typeof value.text !== 'string')
    || !Array.isArray(value.sources) || value.sources.length === 0 || value.sources.length > 100) return null;
  const sources: ChatResultBlock['sources'] = [];
  for (const source of value.sources) {
    if (!object(source) || !id(source.ref) || (source.label !== undefined && typeof source.label !== 'string')) return null;
    sources.push({ ref: source.ref, ...(source.label !== undefined ? { label: source.label } : {}) });
  }
  return { id: value.id, kind: value.kind as ChatResultBlock['kind'], title: value.title,
    ...(value.text !== undefined ? { text: value.text } : {}), sources };
}

/** Validate untrusted bytes before reducing or persisting. Extra fields do not confer authority. */
export function parseChatEventV1(value: unknown): ChatEventV1 | null {
  if (!object(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'capabilities': {
      const capabilities = parseRecoveryCapabilities(value.capabilities);
      return capabilities ? { type: 'capabilities', capabilities } : null;
    }
    case 'lifecycle':
      return CHAT_TURN_PHASES.includes(value.phase as ChatTurnPhase)
        ? { type: 'lifecycle', phase: value.phase as ChatTurnPhase } : null;
    case 'result': {
      if (!Array.isArray(value.blocks) || !value.blocks.length || value.blocks.length > 100) return null;
      const blocks = value.blocks.map(parseResultBlock);
      return blocks.every((block): block is ChatResultBlock => block !== null)
        && new Set(blocks.map((block) => block.id)).size === blocks.length
        ? { type: 'result', blocks } : null;
    }
    case 'error':
      return CHAT_ERROR_CODES.includes(value.code as ChatErrorCode)
        && typeof value.message === 'string' && value.message.trim().length > 0
        && typeof value.retryable === 'boolean'
        ? { type: 'error', code: value.code as ChatErrorCode, message: value.message, retryable: value.retryable } : null;
    case 'tool_call':
    case 'tool_result':
      if (!id(value.callId)) return null;
      if (value.type === 'tool_result' && typeof value.ok !== 'boolean') return null;
      break;
    case 'session':
      if (!id(value.sessionId)) return null;
      break;
    case 'card':
      if (!object(value.card) || !id(value.card.correlationId) || !counter(value.card.createdAt)) return null;
      break;
    case 'card_closed':
      if (!id(value.correlationId)) return null;
      break;
    case 'state':
      if (!counter(value.version) || !Object.hasOwn(value, 'snapshot')) return null;
      break;
  }
  const parsed = parseChatEvent(value.type, value);
  if (!parsed) return null;
  // The legacy parser is intentionally tolerant; the v1 boundary is strict.
  if (parsed.type === 'tool_call' || parsed.type === 'tool_result') {
    if (!id(parsed.name) || (value.summary !== undefined && typeof value.summary !== 'string')) return null;
  }
  if (parsed.type === 'done' && value.usage !== undefined) {
    if (!object(value.usage) || Object.values(value.usage).some((n) =>
      typeof n !== 'number' || !Number.isFinite(n) || n < 0)) return null;
  }
  if (parsed.type === 'done' && value.stopReason !== undefined && typeof value.stopReason !== 'string') return null;
  return parsed as ChatEventV1;
}

export function parseChatEnvelope(value: unknown): ChatProtocolResult<ChatEventEnvelope> {
  if (!object(value)) return invalid();
  if (value.schemaVersion !== CHAT_PROTOCOL_VERSION) return { ok: false, code: 'unsupported-version' };
  if (!id(value.conversationId) || !id(value.turnId) || !id(value.eventId)
    || !counter(value.sequence) || value.sequence === 0) return invalid();
  const event = parseChatEventV1(value.event);
  if (!event) return invalid();
  return { ok: true, value: { schemaVersion: CHAT_PROTOCOL_VERSION,
    conversationId: value.conversationId, turnId: value.turnId, eventId: value.eventId,
    sequence: value.sequence, event } };
}

export function parseChatState(value: unknown): ChatProtocolResult<ChatStateV1> {
  if (!object(value)) return invalid();
  if (value.schemaVersion !== CHAT_STATE_VERSION) return { ok: false, code: 'unsupported-version' };
  const capabilities = parseRecoveryCapabilities(value.capabilities);
  if (!id(value.conversationId) || !id(value.turnId) || !counter(value.revision)
    || !counter(value.lastSequence) || !CHAT_TURN_PHASES.includes(value.phase as ChatTurnPhase)
    || !capabilities) return invalid();
  return { ok: true, value: { schemaVersion: CHAT_STATE_VERSION, conversationId: value.conversationId,
    turnId: value.turnId, revision: value.revision, lastSequence: value.lastSequence,
    phase: value.phase as ChatTurnPhase, capabilities } };
}
