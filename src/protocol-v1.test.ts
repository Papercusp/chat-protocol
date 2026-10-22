import { describe, expect, it } from 'vitest';
import {
  CHAT_ERROR_CODES, CHAT_TURN_PHASES, RECOVERY_CAPABILITY_KEYS,
  chatEventChannel, decodeLegacyChatFrame, encodeLegacyChatFrame, negotiateChatVersion, parseChatEnvelope,
  parseChatEvent, parseChatEventV1, parseChatState, parseRecoveryCapabilities,
  requireChatCapabilities, upgradeLegacyChatFrame,
  type ChatEventEnvelope, type ChatEventV1, type ChatRecoveryCapabilities,
} from './index.js';

const identity = { conversationId: 'conversation-1', turnId: 'turn-1', eventId: 'event-1', sequence: 1 };
const capabilities: ChatRecoveryCapabilities = {
  connectionReplay: true, persistedHistory: true, persistedInteractionDecisions: false,
  completedToolCheckpoints: false, interruptedTurnRecovery: false,
};
const envelope = (event: ChatEventV1): ChatEventEnvelope => ({ schemaVersion: 1, ...identity, event });
const text = envelope({ type: 'delta', text: 'hello' });

describe('version 1 contract boundary', () => {
  it('keeps new lifecycle/results replayable while interaction state and navigation cannot replay effects', () => {
    expect(chatEventChannel('lifecycle')).toBe('event');
    expect(chatEventChannel('result')).toBe('event');
    expect(chatEventChannel('tool_result')).toBe('event');
    expect(chatEventChannel('card')).toBe('state');
    expect(chatEventChannel('card_closed')).toBe('state');
    expect(chatEventChannel('capabilities')).toBe('state');
    expect(chatEventChannel('navigate')).toBe('transient');
  });
  it('round-trips stable server identity without synthesizing a turn or cursor', () => {
    expect(parseChatEnvelope(JSON.parse(JSON.stringify(text)))).toEqual({ ok: true, value: text });
    const tool = envelope({ type: 'tool_result', name: 'document:read', callId: 'call-1', ok: true, summary: 'found' });
    expect(parseChatEnvelope(tool)).toEqual({ ok: true, value: tool });
  });

  it.each([undefined, null, '1', -1, 2, 0, NaN])('refuses envelope version %s without legacy inference', (schemaVersion) => {
    expect(parseChatEnvelope({ ...text, schemaVersion })).toEqual({ ok: false, code: 'unsupported-version' });
  });

  it.each([undefined, null, '0', 2, -1])('negotiation rejects absent or unsupported version %s', (version) => {
    expect(negotiateChatVersion(version)).toEqual({ ok: false, code: 'unsupported-version' });
  });
  it('negotiates only the explicit legacy0/v1 adoption window', () => {
    expect(negotiateChatVersion(0)).toEqual({ ok: true, value: 0 });
    expect(negotiateChatVersion(1)).toEqual({ ok: true, value: 1 });
  });

  it('rejects missing/blank identity, unsafe cursors and malformed events', () => {
    for (const field of ['conversationId', 'turnId', 'eventId']) {
      for (const value of ['', ' x', 42, undefined, 'x'.repeat(513), 'one\ntwo', 'one\u0000two', 'one\u007ftwo']) {
        expect(parseChatEnvelope({ ...text, [field]: value })).toEqual({ ok: false, code: 'invalid-frame' });
      }
    }
    for (const sequence of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
      expect(parseChatEnvelope({ ...text, sequence })).toEqual({ ok: false, code: 'invalid-frame' });
    }
    for (const event of [null, [], { type: 'delta' }, { type: 'products', items: [] }]) {
      expect(parseChatEnvelope({ ...text, event })).toEqual({ ok: false, code: 'invalid-frame' });
    }
    expect(parseChatEnvelope({ ...text, sequence: Number.MAX_SAFE_INTEGER }).ok).toBe(true);
  });

  it('requires stable tool identity and an actual result status', () => {
    expect(parseChatEventV1({ type: 'tool_call', name: 'read' })).toBeNull();
    expect(parseChatEventV1({ type: 'tool_result', name: 'read', callId: 'call-1' })).toBeNull();
    expect(parseChatEventV1({ type: 'tool_result', name: 'read', callId: 'call-1', ok: false }))
      .toEqual({ type: 'tool_result', name: 'read', callId: 'call-1', ok: false });
    expect(parseChatEventV1({ type: 'tool_call', name: 'read', callId: '' })).toBeNull();
  });

  it('preserves every lifecycle phase, including cancellation and unknown effects distinctly', () => {
    for (const phase of CHAT_TURN_PHASES) {
      expect(parseChatEnvelope(envelope({ type: 'lifecycle', phase })).ok).toBe(true);
    }
    expect(parseChatEventV1({ type: 'lifecycle', phase: 'recovered-by-retry' })).toBeNull();
  });

  it('requires normalized error policy instead of implying retry from an error string', () => {
    for (const code of CHAT_ERROR_CODES) {
      const event = { type: 'error' as const, code, message: 'failed', retryable: false };
      expect(parseChatEventV1(event)).toEqual(event);
    }
    expect(parseChatEventV1({ type: 'error', message: 'retry me' })).toBeNull();
    expect(parseChatEventV1({ type: 'error', code: 'invented', message: 'x', retryable: true })).toBeNull();
    expect(parseChatEventV1({ type: 'error', code: 'provider-failure', message: '', retryable: true })).toBeNull();
  });

  it('preserves measured provenance and rejects false usage/invalid state', () => {
    const event = { type: 'provenance' as const, engine: 'native', model: 'selected-model', accountRoute: null };
    expect(parseChatEventV1(event)).toEqual(event);
    expect(parseChatEventV1({ type: 'provenance', model: 'selected-model' })).toBeNull();
    expect(parseChatEventV1({ ...event, engine: '' })).toBeNull();
    expect(parseChatEventV1({ ...event, accountRoute: 42 })).toBeNull();
    for (const usage of [{ costUsd: -1 }, { inputTokens: NaN }, { totalTokens: '2' },
      { inputTokens: 1.5 }, { outputTokens: Number.MAX_SAFE_INTEGER + 1 }, []]) {
      expect(parseChatEventV1({ type: 'done', usage })).toBeNull();
    }
    expect(parseChatEventV1({ type: 'done', stopReason: 7 })).toBeNull();
    expect(parseChatEventV1({ type: 'done', usage: { inputTokens: 0, outputTokens: 2 } }))
      .toEqual({ type: 'done', usage: { inputTokens: 0, outputTokens: 2 } });
    expect(parseChatEventV1({ type: 'done', usage: { costUsd: 0.001, privateField: 'untrusted' } }))
      .toEqual({ type: 'done', usage: { costUsd: 0.001 } });
    expect(parseChatEventV1({ type: 'state', version: NaN, snapshot: {} })).toBeNull();
    expect(parseChatEventV1({ type: 'state', version: 1 })).toBeNull();
    expect(parseChatEventV1({ type: 'card', card: { correlationId: 'card-1', prompt: 'p', createdAt: -1 } })).toBeNull();
  });

  it('requires grounded non-shopping result blocks and does not pass model HTML fields through', () => {
    const block = { id: 'doc-1', kind: 'document', title: 'A document', sources: [{ ref: 'document:1', label: 'Source' }] };
    expect(parseChatEventV1({ type: 'result', blocks: [{ ...block, html: '<script>bad()</script>' }] }))
      .toEqual({ type: 'result', blocks: [block] });
    for (const blocks of [[], [block, block], [{ ...block, sources: [] }], [{ ...block, sources: [{ ref: '' }] }],
      [{ ...block, kind: 'shopping-cart' }], Array.from({ length: 101 }, (_, i) => ({ ...block, id: String(i) }))]) {
      expect(parseChatEventV1({ type: 'result', blocks })).toBeNull();
    }
    for (const kind of ['entity', 'document', 'report', 'task', 'suggestion']) {
      expect(parseChatEventV1({ type: 'result', blocks: [{ ...block, kind }] })).not.toBeNull();
    }
  });
});

describe('independent capabilities and state schema', () => {
  it('does not infer interrupted execution recovery from replay or persisted history', () => {
    expect(requireChatCapabilities(capabilities, ['connectionReplay', 'persistedHistory']).ok).toBe(true);
    expect(requireChatCapabilities(capabilities, ['interruptedTurnRecovery']))
      .toEqual({ ok: false, code: 'unsupported-capability' });
    expect(parseChatEventV1({ type: 'capabilities', capabilities }))
      .toEqual({ type: 'capabilities', capabilities });
    for (const key of RECOVERY_CAPABILITY_KEYS) {
      expect(parseRecoveryCapabilities({ ...capabilities, [key]: undefined })).toBeNull();
      expect(parseRecoveryCapabilities({ ...capabilities, [key]: 'true' })).toBeNull();
    }
    expect(requireChatCapabilities({ ...capabilities, interruptedTurnRecovery: true }, ['interruptedTurnRecovery']).ok).toBe(true);
  });
  it('version-checks persisted state and preserves revision/unknown-outcome state', () => {
    const state = { schemaVersion: 1, conversationId: 'c', turnId: 't', revision: 0, lastSequence: 0,
      phase: 'needs-reconciliation', capabilities };
    expect(parseChatState(state)).toEqual({ ok: true, value: state });
    expect(parseChatState({ ...state, schemaVersion: 2 })).toEqual({ ok: false, code: 'unsupported-version' });
    expect(parseChatState({ ...state, revision: -1 })).toEqual({ ok: false, code: 'invalid-frame' });
    expect(parseChatState({ ...state, phase: 'silently-retry' })).toEqual({ ok: false, code: 'invalid-frame' });
    expect(parseChatState({ ...state, capabilities: {} })).toEqual({ ok: false, code: 'invalid-frame' });
  });
});

describe('explicit legacy0 host adapters', () => {
  it('bridges measured Scout token/content and preserves Papercup delta/text', () => {
    expect(upgradeLegacyChatFrame('scout', 'token', { type: 'token', content: 'hello' }, identity))
      .toEqual({ ok: true, value: text });
    expect(upgradeLegacyChatFrame('papercup', 'delta', { text: 'hello' }, identity))
      .toEqual({ ok: true, value: text });
    expect(encodeLegacyChatFrame('scout', text))
      .toEqual({ ok: true, value: { eventName: 'token', data: { type: 'token', content: 'hello' } } });
    expect(encodeLegacyChatFrame('papercup', text))
      .toEqual({ ok: true, value: { eventName: 'delta', data: { type: 'delta', text: 'hello' } } });
    // The existing Papercup parser remains strict about its own vocabulary.
    expect(parseChatEvent('token', { content: 'hello' })).toBeNull();
    expect(decodeLegacyChatFrame('papercup', 'token', { content: 'hello' }).ok).toBe(false);
    expect(decodeLegacyChatFrame('scout', 'delta', { text: 'hello' }).ok).toBe(false);
  });

  it('requires a host-owned call mapping for Scout and refuses conflicting Papercup identity', () => {
    const data = { type: 'tool_start', tool: 'document:read' };
    expect(upgradeLegacyChatFrame('scout', 'tool_start', data, identity).ok).toBe(false);
    const upgraded = upgradeLegacyChatFrame('scout', 'tool_start', data, identity, 'call-1');
    expect(upgraded).toEqual({ ok: true, value: envelope({ type: 'tool_call', name: 'document:read', callId: 'call-1' }) });
    if (!upgraded.ok) throw new Error('positive control failed');
    expect(encodeLegacyChatFrame('scout', upgraded.value)).toEqual({ ok: true,
      value: { eventName: 'tool_start', data } });
    const papercup = { name: 'document:read', callId: 'original', input: { ref: 'document:1' } };
    expect(upgradeLegacyChatFrame('papercup', 'tool_call', papercup, identity, 'different').ok).toBe(false);
    expect(upgradeLegacyChatFrame('papercup', 'tool_call', papercup, identity).ok).toBe(true);
    expect(upgradeLegacyChatFrame('papercup', 'tool_result', { name: 'read', callId: 'original' }, identity).ok).toBe(false);
  });

  it('normalizes old errors without granting retry permission', () => {
    const upgraded = upgradeLegacyChatFrame('scout', 'error', { message: 'provider down' }, identity);
    expect(upgraded).toEqual({ ok: true, value: envelope({ type: 'error', message: 'provider down', code: 'legacy-error', retryable: false }) });
    if (!upgraded.ok) throw new Error('positive control failed');
    expect(encodeLegacyChatFrame('papercup', upgraded.value))
      .toEqual({ ok: true, value: { eventName: 'error', data: { type: 'error', message: 'provider down' } } });
  });

  it('refuses future envelopes, contradictory event names and malformed legacy shapes', () => {
    expect(decodeLegacyChatFrame('scout', 'token', { schemaVersion: 2, content: 'x' }))
      .toEqual({ ok: false, code: 'unsupported-version' });
    expect(decodeLegacyChatFrame('scout', 'token', { type: 'error', content: 'x' }).ok).toBe(false);
    expect(decodeLegacyChatFrame('scout', 'token', { content: 42 }).ok).toBe(false);
    expect(decodeLegacyChatFrame('scout', 'tool_start', { tool: '' }).ok).toBe(false);
    expect(decodeLegacyChatFrame('scout', 'products', { items: [] }))
      .toEqual({ ok: false, code: 'unsupported-event' });
    expect(decodeLegacyChatFrame('papercup', 'delta', []).ok).toBe(false);
    for (const event of [
      { type: 'lifecycle' as const, phase: 'cancelled' as const },
      { type: 'capabilities' as const, capabilities },
      { type: 'result' as const, blocks: [{ id: '1', kind: 'document' as const, title: 'Document', sources: [{ ref: 'doc:1' }] }] },
    ]) {
      expect(encodeLegacyChatFrame('papercup', envelope(event))).toEqual({ ok: false, code: 'unsupported-event' });
    }
  });
});
