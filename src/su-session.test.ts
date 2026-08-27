import { describe, expect, it } from 'vitest';
import {
  SU_SESSION_BACKENDS,
  SU_SESSION_COMMAND_TYPES,
  SU_SESSION_EVENT_TYPES,
  SU_SESSION_FEATURES,
  SU_SESSION_LIFECYCLE_STATES,
  SU_SESSION_PROTOCOL_VERSION,
  SU_SESSION_SCHEMA,
  assertNeverSuSession,
  isSuSessionBackend,
  isSuSessionCommandType,
  isSuSessionEventType,
  isSuSessionLifecycleState,
  type SuSessionBackend,
  type SuSessionCapabilities,
  type SuSessionCommand,
  type SuSessionCommandType,
  type SuSessionDescriptor,
  type SuSessionEvent,
  type SuSessionEventType,
  type SuSessionIdentity,
} from './index';

const identity = <B extends SuSessionBackend>(backend: B): SuSessionIdentity<B> => ({
  agentChatId: `chat-${backend}`,
  advSessionId: 41,
  backend,
  nativeSessionId: `native-${backend}`,
  ownerId: 'su-owner',
  workspaceId: 'papercusp-workspace',
  harnessSlug: 'papercusp',
});

const supported = { state: 'supported', implementation: 'native' } as const;
const hostSupported = { state: 'supported', implementation: 'host' } as const;
const capabilities: SuSessionCapabilities = {
  commands: {
    owner_turn: supported,
    interrupt: supported,
    resume: supported,
    fork: { state: 'unsupported', reason: 'backend has no native fork' },
    focus: hostSupported,
    end: supported,
  },
  features: {
    'tool-events': supported,
    'interactive-cards': { state: 'conditional', implementation: 'host', reason: 'tool support required' },
    'reasoning-stream': supported,
    usage: supported,
    compaction: supported,
  },
};

const descriptors = {
  claude: {
    identity: identity('claude'),
    lifecycle: 'ready',
    runtimeGeneration: 1,
    role: 'su',
    model: 'claude-opus',
    accountRoute: 'default',
    carry: 'warm',
    modes: ['auto'],
    capabilities,
    backendExtension: { backend: 'claude', configDir: '/tmp/claude', configDirSource: 'live-process' },
  },
  codex: {
    identity: identity('codex'),
    lifecycle: 'ready',
    runtimeGeneration: 1,
    role: 'su',
    model: 'gpt-5.6',
    accountRoute: 'default',
    carry: 'warm',
    modes: ['auto'],
    capabilities,
    backendExtension: { backend: 'codex', codexHome: '/tmp/codex' },
  },
  omp: {
    identity: identity('omp'),
    lifecycle: 'ready',
    runtimeGeneration: 1,
    role: 'su',
    model: 'local-model',
    accountRoute: null,
    carry: 'warm',
    modes: [],
    capabilities,
    backendExtension: { backend: 'omp', agentHome: '/tmp/omp' },
  },
} satisfies { [B in SuSessionBackend]: SuSessionDescriptor<B> };

const commandBase = {
  schema: SU_SESSION_SCHEMA,
  protocolVersion: SU_SESSION_PROTOCOL_VERSION,
  issuedAt: '2026-08-27T20:00:00.000Z',
  target: identity('claude'),
};

const commandSamples = {
  owner_turn: { ...commandBase, type: 'owner_turn', commandId: 'c1', turnId: 't1', content: 'Continue.' },
  interrupt: { ...commandBase, type: 'interrupt', commandId: 'c2', reason: 'owner interrupt' },
  resume: { ...commandBase, type: 'resume', commandId: 'c3', cause: 'pui-restart' },
  fork: { ...commandBase, type: 'fork', commandId: 'c4', fromSequence: 17 },
  focus: { ...commandBase, type: 'focus', commandId: 'c5' },
  end: { ...commandBase, type: 'end', commandId: 'c6', reason: 'owner ended session' },
} satisfies { [K in SuSessionCommandType]: Extract<SuSessionCommand<'claude'>, { type: K }> };

const eventBase = {
  schema: SU_SESSION_SCHEMA,
  protocolVersion: SU_SESSION_PROTOCOL_VERSION,
  eventId: 'e1',
  sequence: 1,
  at: '2026-08-27T20:00:01.000Z',
  session: identity('claude'),
};

const eventSamples = {
  session: { ...eventBase, type: 'session', descriptor: descriptors.claude },
  lifecycle: {
    ...eventBase,
    type: 'lifecycle',
    previousState: 'starting',
    state: 'ready',
    runtimeGeneration: 1,
  },
  command_result: {
    ...eventBase,
    type: 'command_result',
    commandId: 'c1',
    commandType: 'owner_turn',
    status: 'completed',
  },
  transcript: {
    ...eventBase,
    type: 'transcript',
    phase: 'delta',
    turnId: 't1',
    role: 'assistant',
    channel: 'text',
    content: 'Working',
  },
  tool: {
    ...eventBase,
    type: 'tool',
    phase: 'completed',
    turnId: 't1',
    callId: 'tool-1',
    name: 'coord:orient',
    output: { ok: true },
    isError: false,
  },
  card: {
    ...eventBase,
    type: 'card',
    phase: 'opened',
    turnId: 't1',
    card: { correlationId: 'card-1', createdAt: 1, prompt: 'Choose' },
  },
  backend: {
    ...eventBase,
    type: 'backend',
    extension: descriptors.claude.backendExtension,
  },
  error: {
    ...eventBase,
    type: 'error',
    scope: 'transport',
    code: 'consumer_backpressure',
    message: 'consumer fell behind',
    recoverable: true,
    details: { resumeFromSequence: 4 },
  },
} satisfies { [K in SuSessionEventType]: Extract<SuSessionEvent<'claude'>, { type: K }> };

function commandKind(command: SuSessionCommand): SuSessionCommandType {
  switch (command.type) {
    case 'owner_turn':
    case 'interrupt':
    case 'resume':
    case 'fork':
    case 'focus':
    case 'end':
      return command.type;
    default:
      return assertNeverSuSession(command);
  }
}

function eventKind(event: SuSessionEvent): SuSessionEventType {
  switch (event.type) {
    case 'session':
    case 'lifecycle':
    case 'command_result':
    case 'transcript':
    case 'tool':
    case 'card':
    case 'backend':
    case 'error':
      return event.type;
    default:
      return assertNeverSuSession(event);
  }
}

describe('SU-session wire contract', () => {
  it('enumerates every backend, lifecycle state, command, event, and negotiated feature', () => {
    expect(SU_SESSION_BACKENDS).toEqual(['claude', 'codex', 'omp']);
    expect(SU_SESSION_LIFECYCLE_STATES).toEqual([
      'starting',
      'ready',
      'running',
      'waiting-for-owner',
      'interrupted',
      'compacting',
      'resuming',
      'ended',
      'failed',
    ]);
    expect(SU_SESSION_COMMAND_TYPES).toEqual(Object.keys(commandSamples));
    expect(SU_SESSION_EVENT_TYPES).toEqual(Object.keys(eventSamples));
    expect(SU_SESSION_FEATURES).toEqual([
      'tool-events',
      'interactive-cards',
      'reasoning-stream',
      'usage',
      'compaction',
    ]);
  });

  it('round-trips every command and event through JSON without losing contract data', () => {
    for (const command of Object.values(commandSamples)) {
      expect(JSON.parse(JSON.stringify(command))).toEqual(command);
      expect(commandKind(command)).toBe(command.type);
    }
    for (const event of Object.values(eventSamples)) {
      expect(JSON.parse(JSON.stringify(event))).toEqual(event);
      expect(eventKind(event)).toBe(event.type);
    }
  });

  it('round-trips typed metadata for all three native backends', () => {
    for (const [backend, descriptor] of Object.entries(descriptors)) {
      expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
      expect(descriptor.identity.backend).toBe(backend);
      expect(descriptor.backendExtension.backend).toBe(backend);
    }
  });

  it('keeps unsupported behavior explicit and reasoned', () => {
    expect(descriptors.claude.capabilities.commands.fork).toEqual({
      state: 'unsupported',
      reason: 'backend has no native fork',
    });
  });

  it('narrows wire discriminants without accepting provider/model-port names', () => {
    expect(isSuSessionBackend('claude')).toBe(true);
    expect(isSuSessionBackend('model-port')).toBe(false);
    expect(isSuSessionLifecycleState('waiting-for-owner')).toBe(true);
    expect(isSuSessionLifecycleState('thinking')).toBe(false);
    expect(isSuSessionCommandType('owner_turn')).toBe(true);
    expect(isSuSessionCommandType('complete')).toBe(false);
    expect(isSuSessionEventType('backend')).toBe(true);
    expect(isSuSessionEventType('provider_delta')).toBe(false);
  });
});
