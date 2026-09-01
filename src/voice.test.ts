import { describe, expect, it } from 'vitest';
import {
  VOICE_PROTOCOL_VERSION,
  createVoiceTurnExecutorSession,
  parseVoiceCapabilityEnvelope,
  parseVoicePrincipal,
  parseVoiceTurnEvent,
  parseVoiceTurnEventJson,
  parseVoiceTurnRequest,
  parseVoiceTurnRequestJson,
  serializeVoiceTurnEvent,
  serializeVoiceTurnRequest,
  type VoiceTurnEvent,
  type VoiceTurnExecutorDescriptor,
  type VoiceTurnRequest,
} from './voice';

function ownerTurn(over: Partial<VoiceTurnRequest> = {}): VoiceTurnRequest {
  return {
    version: VOICE_PROTOCOL_VERSION,
    turnId: 'turn-owner-1',
    sequence: 4,
    occurredAt: '2026-08-31T15:00:00.000Z',
    transport: 'papercup-local',
    latencyClass: 'deliberative',
    transcript: 'What is on my calendar?',
    conversation: { kind: 'operator', id: 'operator-conversation-1', parentOperatorConversationId: null },
    principal: {
      kind: 'owner',
      subjectId: 'owner-1',
      authenticated: true,
      authoritySource: 'owner-session',
    },
    capabilities: {
      read: ['conversation-history', 'personal-memory', 'contacts', 'calendar', 'email'],
      write: ['conversation-turn', 'draft'],
      tools: ['calendar:list', 'email:draft'],
    },
    ...over,
  };
}

describe('voice turn request contract', () => {
  it('round-trips a valid owner request without changing canonical fields', () => {
    const request = ownerTurn();
    expect(parseVoiceTurnRequestJson(serializeVoiceTurnRequest(request))).toEqual(request);
  });

  it.each([
    {
      name: 'guest invite',
      principal: { kind: 'guest', subjectId: 'invite-1', authenticated: true, authoritySource: 'invite' },
    },
    {
      name: 'known caller',
      principal: { kind: 'caller', subjectId: 'contact-44', authenticated: false, authoritySource: 'call-ledger' },
    },
    {
      name: 'unknown caller',
      principal: { kind: 'unknown', subjectId: null, authenticated: false, authoritySource: 'unknown' },
    },
  ])('accepts a policy-scoped $name request', ({ principal }) => {
    const parsed = parseVoiceTurnRequest(ownerTurn({
      transport: 'phone-livekit',
      latencyClass: 'interactive',
      conversation: { kind: 'phone-call', id: 'phone-room-1', parentOperatorConversationId: null },
      principal: principal as VoiceTurnRequest['principal'],
      capabilities: { read: ['caller-history', 'call-policy'], write: ['call-outcome'], tools: [] },
    }));
    expect(parsed?.principal).toEqual(principal);
    expect(parsed?.conversation.kind).toBe('phone-call');
  });

  it('rejects malformed, unsupported, or contradictory authority envelopes', () => {
    expect(parseVoiceTurnRequest(null)).toBeNull();
    expect(parseVoiceTurnRequest({ ...ownerTurn(), version: 2 })).toBeNull();
    expect(parseVoiceTurnRequest({ ...ownerTurn(), transcript: '   ' })).toBeNull();
    expect(parseVoiceTurnRequest({ ...ownerTurn(), sequence: -1 })).toBeNull();
    expect(parseVoiceTurnRequest({ ...ownerTurn(), occurredAt: 'not-a-date' })).toBeNull();
    expect(parseVoicePrincipal({
      kind: 'owner', subjectId: 'owner-1', authenticated: false, authoritySource: 'owner-session',
    })).toBeNull();
    expect(parseVoicePrincipal({
      kind: 'unknown', subjectId: 'secret-owner-id', authenticated: false, authoritySource: 'unknown',
    })).toBeNull();
    expect(parseVoiceCapabilityEnvelope({
      read: ['calendar', 'calendar'], write: [], tools: [],
    })).toBeNull();
    expect(parseVoiceCapabilityEnvelope({
      read: ['owner-everything'], write: [], tools: [],
    })).toBeNull();
    expect(parseVoiceTurnRequestJson('{bad json')).toBeNull();
  });

  it('requires operator conversations to have no parent and permits explicit owner-call linking', () => {
    expect(parseVoiceTurnRequest(ownerTurn({
      conversation: {
        kind: 'operator',
        id: 'operator-conversation-1',
        parentOperatorConversationId: 'another-owner-thread',
      } as unknown as VoiceTurnRequest['conversation'],
    }))).toBeNull();

    const linked = parseVoiceTurnRequest(ownerTurn({
      transport: 'phone-livekit',
      conversation: {
        kind: 'phone-call',
        id: 'phone-room-owner',
        parentOperatorConversationId: 'operator-conversation-1',
      },
    }));
    expect(linked?.conversation).toEqual({
      kind: 'phone-call',
      id: 'phone-room-owner',
      parentOperatorConversationId: 'operator-conversation-1',
    });
  });
});

describe('voice turn event contract', () => {
  const completed: VoiceTurnEvent = {
    version: VOICE_PROTOCOL_VERSION,
    type: 'completed',
    turnId: 'turn-owner-1',
    sequence: 4,
    emittedAt: '2026-08-31T15:00:01.250Z',
    metrics: {
      executor: 'papercup-deep',
      latencyClass: 'deliberative',
      firstSentenceMs: 420,
      totalMs: 1_250,
    },
  };

  it('round-trips canonical completion metrics', () => {
    expect(parseVoiceTurnEventJson(serializeVoiceTurnEvent(completed))).toEqual(completed);
  });

  it.each<VoiceTurnEvent>([
    {
      version: 1,
      type: 'transcript.final',
      turnId: 't1',
      sequence: 0,
      emittedAt: '2026-08-31T15:00:00Z',
      text: 'hello',
    },
    {
      version: 1,
      type: 'assistant.sentence',
      turnId: 't1',
      sequence: 1,
      emittedAt: '2026-08-31T15:00:01Z',
      text: 'Hi there.',
      sentenceIndex: 0,
    },
    {
      version: 1,
      type: 'interruption',
      turnId: 't1',
      sequence: 2,
      emittedAt: '2026-08-31T15:00:02Z',
      reason: 'user',
    },
    {
      version: 1,
      type: 'error',
      turnId: 't1',
      sequence: 3,
      emittedAt: '2026-08-31T15:00:03Z',
      code: 'executor_unavailable',
      message: 'No executor is available.',
      retryable: true,
    },
  ])('accepts $type', (event) => {
    expect(parseVoiceTurnEvent(event)).toEqual(event);
  });

  it('rejects malformed metrics and unknown event types', () => {
    expect(parseVoiceTurnEvent({ ...completed, metrics: { ...completed.metrics, totalMs: -1 } })).toBeNull();
    expect(parseVoiceTurnEvent({ ...completed, type: 'assistant.secret' })).toBeNull();
    expect(parseVoiceTurnEventJson('[]')).toBeNull();
  });
});

describe('shared voice executor lifecycle', () => {
  const streaming: VoiceTurnExecutorDescriptor = {
    id: 'gemini-streaming',
    latencyClass: 'interactive',
    delivery: 'streaming',
  };

  it('emits one canonical ordered lifecycle with first-sentence and total latency', () => {
    const startedAtMs = Date.parse('2026-08-31T18:00:00.000Z');
    let now = startedAtMs;
    const events: VoiceTurnEvent[] = [];
    const turn = ownerTurn({
      turnId: 'executor-turn-1',
      occurredAt: new Date(startedAtMs).toISOString(),
      latencyClass: 'interactive',
    });
    const session = createVoiceTurnExecutorSession({
      descriptor: streaming,
      request: { turn, context: { status: 'ready' } },
      emit: (event) => { events.push(event); },
      now: () => now,
    });

    now += 90;
    session.assistantSentence('First sentence.');
    now += 160;
    session.assistantSentence('Second sentence.');
    now += 50;
    session.complete();

    expect(events.map((event) => event.type)).toEqual([
      'transcript.final',
      'assistant.sentence',
      'assistant.sentence',
      'completed',
    ]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3]);
    expect(events[1]).toMatchObject({ sentenceIndex: 0, text: 'First sentence.' });
    expect(events[2]).toMatchObject({ sentenceIndex: 1, text: 'Second sentence.' });
    expect(events[3]).toMatchObject({
      metrics: {
        executor: 'gemini-streaming',
        latencyClass: 'interactive',
        firstSentenceMs: 90,
        totalMs: 300,
      },
    });
    expect(session.active).toBe(false);
    expect(session.complete()).toBeNull();
    expect(session.assistantSentence('too late')).toBeNull();
  });

  it('snapshots and freezes server-selected authority before executor dispatch', () => {
    const turn = ownerTurn({ latencyClass: 'interactive' });
    const session = createVoiceTurnExecutorSession({
      descriptor: streaming,
      request: { turn, context: { source: 'server-vault' } },
      emit: () => {},
    });

    turn.capabilities.tools.push('untrusted:later-mutation');
    expect(session.request.turn.capabilities.tools).toEqual(['calendar:list', 'email:draft']);
    expect(() => session.request.turn.capabilities.tools.push('untrusted:executor-mutation'))
      .toThrow();
    expect(session.request.turn.principal).toEqual(turn.principal);
  });

  it('rejects latency-class mismatches and settles only one terminal event', () => {
    expect(() => createVoiceTurnExecutorSession({
      descriptor: streaming,
      request: { turn: ownerTurn(), context: null },
      emit: () => {},
    })).toThrow(/cannot handle deliberative turns/);

    const events: VoiceTurnEvent[] = [];
    const session = createVoiceTurnExecutorSession({
      descriptor: streaming,
      request: { turn: ownerTurn({ latencyClass: 'interactive' }), context: null },
      emit: (event) => { events.push(event); },
    });
    expect(session.interrupt('policy')?.type).toBe('interruption');
    expect(session.error({ code: 'late', message: 'late failure', retryable: false })).toBeNull();
    expect(events.map((event) => event.type)).toEqual(['transcript.final', 'interruption']);
  });

  it('keeps a failing observation sink off the executor/media path', () => {
    const session = createVoiceTurnExecutorSession({
      descriptor: streaming,
      request: { turn: ownerTurn({ latencyClass: 'interactive' }), context: null },
      emit: () => { throw new Error('telemetry unavailable'); },
    });
    expect(() => {
      session.assistantSentence('Still speaking.');
      session.complete();
    }).not.toThrow();
  });
});
