import { parseChatEnvelope, type CardResponse, type CardSpec, type ChatEventEnvelope } from '../index.js';

/** D-011 fixture policy, not an implicit change to either production host's policy. */
export const FIXTURE_BUDGETS = Object.freeze({
  retryAttempts: 2, backoffMs: 10, deadlineMs: 100, replayEvents: 4,
  interactionExpiryMs: 100, contextTokens: 256,
});
export type FixtureCode = 'invalid-frame' | 'unauthorized' | 'stale-revision' | 'already-decided'
  | 'interaction-expired' | 'replay-expired' | 'context-budget' | 'retry-exhausted'
  | 'deadline-exceeded' | 'effect-unknown' | 'storage-unavailable';
export class FixtureRefusal extends Error {
  constructor(readonly code: FixtureCode) { super(code); }
}
export class FakeClock {
  now = 0;
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new FixtureRefusal('invalid-frame');
    this.now += ms;
  }
  /** At the deadline is expired; no late output or effect can escape. */
  spend(ms: number, deadline: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new FixtureRefusal('invalid-frame');
    if (this.now + ms >= deadline) {
      this.now = Math.max(this.now, deadline);
      throw new FixtureRefusal('deadline-exceeded');
    }
    this.advance(ms);
  }
}
export interface FixtureScope { tenantId: string; customerId: string; publicOwnerId: string }
export const fixtureScope = (): FixtureScope => ({ tenantId: 'tenant-a', customerId: 'customer-a', publicOwnerId: 'owner-a' });
export const sameScope = (a: FixtureScope, b: FixtureScope): boolean =>
  a.tenantId === b.tenantId && a.customerId === b.customerId && a.publicOwnerId === b.publicOwnerId;
export interface FixtureAnswer {
  scope: FixtureScope;
  revision: number;
  response: CardResponse;
}
export interface PendingInteraction {
  scope: FixtureScope;
  revision: number;
  expiresAt: number;
  spec: CardSpec;
}
export interface TerminalDecision { correlationId: string; revision: number; value: Record<string, unknown> }
export interface CompletedEffect { key: string; scope: FixtureScope; result: unknown }
/** Reuse this object across fake workers. This is explicitly NOT production persistence. */
export function fakeDatabase() {
  return {
    completed: new Map<string, CompletedEffect>(), decisions: new Map<string, TerminalDecision>(),
    pending: new Map<string, PendingInteraction>(), effects: [] as CompletedEffect[],
    events: [] as ChatEventEnvelope[],
  };
}
export type FakeDatabase = ReturnType<typeof fakeDatabase>;
export class FakeStorage {
  available = true;
  commitDelayMs = 0;
  loseNextAcknowledgement = false;
  constructor(readonly clock: FakeClock, readonly db = fakeDatabase()) {}
  private beforeCommit(): void {
    if (!this.available) throw new FixtureRefusal('storage-unavailable');
    this.clock.spend(this.commitDelayMs, FIXTURE_BUDGETS.deadlineMs);
  }
  private acknowledge(): void {
    if (this.loseNextAcknowledgement) {
      this.loseNextAcknowledgement = false;
      throw new FixtureRefusal('effect-unknown');
    }
  }
  complete(effect: CompletedEffect): boolean {
    this.beforeCommit();
    const old = this.db.completed.get(effect.key);
    if (old) {
      if (!sameScope(old.scope, effect.scope)) throw new FixtureRefusal('unauthorized');
      return false;
    }
    this.db.completed.set(effect.key, structuredClone(effect));
    this.db.effects.push(structuredClone(effect));
    this.acknowledge();
    return true;
  }
  decide(correlationId: string, revision: number, value: Record<string, unknown>): TerminalDecision {
    this.beforeCommit();
    const pending = this.db.pending.get(correlationId);
    if (!pending || pending.revision !== revision) throw new FixtureRefusal('stale-revision');
    if (this.db.decisions.has(correlationId)) throw new FixtureRefusal('already-decided');
    const key = `decision:${correlationId}`;
    if (this.db.completed.has(key)) throw new FixtureRefusal('effect-unknown');
    const terminal = { correlationId, revision: revision + 1, value: structuredClone(value) };
    // One synchronous fake transaction: the terminal decision and downstream effect commit together.
    this.db.decisions.set(correlationId, terminal);
    pending.revision += 1;
    const effect = { key, scope: structuredClone(pending.scope), result: structuredClone(terminal) };
    this.db.completed.set(key, effect);
    this.db.effects.push(structuredClone(effect));
    this.acknowledge();
    return structuredClone(terminal);
  }
  append(input: unknown): void {
    const parsed = parseChatEnvelope(input);
    if (!parsed.ok) throw new FixtureRefusal('invalid-frame');
    const previous = this.db.events.at(-1);
    if (previous && (previous.conversationId !== parsed.value.conversationId
      || previous.turnId !== parsed.value.turnId || parsed.value.sequence !== previous.sequence + 1)) {
      throw new FixtureRefusal('invalid-frame');
    }
    this.db.events.push(structuredClone(parsed.value));
    if (this.db.events.length > FIXTURE_BUDGETS.replayEvents) this.db.events.shift();
  }
  replay(after: number): ChatEventEnvelope[] {
    if (!Number.isSafeInteger(after) || after < 0) throw new FixtureRefusal('invalid-frame');
    const first = this.db.events[0];
    if (first && after < first.sequence - 1) throw new FixtureRefusal('replay-expired');
    return structuredClone(this.db.events.filter(event => event.sequence > after));
  }
}
export type ProviderStep = { delayMs: number } & ({ text: string } | { failure: 'retryable' | 'fatal' });
export class FakeProvider {
  calls = 0;
  constructor(readonly clock: FakeClock, readonly steps: readonly ProviderStep[]) {}
  run(contextTokens: number): string {
    if (!Number.isSafeInteger(contextTokens) || contextTokens < 0) throw new FixtureRefusal('invalid-frame');
    if (contextTokens > FIXTURE_BUDGETS.contextTokens) throw new FixtureRefusal('context-budget');
    const deadline = this.clock.now + FIXTURE_BUDGETS.deadlineMs;
    // Two retries AFTER the initial attempt; deterministic backoff consumes the same deadline.
    for (let attempt = 0; attempt <= FIXTURE_BUDGETS.retryAttempts; attempt++) {
      const step = this.steps[this.calls++];
      if (!step) throw new FixtureRefusal('retry-exhausted');
      this.clock.spend(step.delayMs, deadline);
      if ('text' in step) return step.text;
      if (step.failure === 'fatal' || attempt === FIXTURE_BUDGETS.retryAttempts) {
        throw new FixtureRefusal('retry-exhausted');
      }
      this.clock.spend(FIXTURE_BUDGETS.backoffMs, deadline);
    }
    throw new FixtureRefusal('retry-exhausted');
  }
}
export function fourEventReplay(): ChatEventEnvelope[] {
  return [
    { type: 'tool_call', name: 'document:read', callId: 'read-1', input: { ref: 'document:1' } },
    { type: 'tool_result', name: 'document:read', callId: 'read-1', ok: true, summary: 'Found document' },
    { type: 'delta', text: 'Here is the document.' }, { type: 'done' },
  ].map((event, i) => ({ schemaVersion: 1, conversationId: 'conversation-1', turnId: 'turn-1',
    eventId: `event-${i + 1}`, sequence: i + 1, event } as ChatEventEnvelope));
}
export function createFixture() {
  const clock = new FakeClock();
  const storage = new FakeStorage(clock);
  const scope = fixtureScope();
  storage.db.pending.set('question-1', {
    scope: structuredClone(scope), revision: 0, expiresAt: FIXTURE_BUDGETS.interactionExpiryMs,
    spec: { prompt: 'Read the document?', presentation: { kind: 'radio', options: [
      { id: 'accept', label: 'Read' }, { id: 'reject', label: 'Cancel' },
    ] } },
  });
  return { clock, storage, scope, authorized: true };
}
export type ConformanceFixture = ReturnType<typeof createFixture>;
export function authorizedAnswer(fixture: ConformanceFixture): FixtureAnswer {
  return { scope: structuredClone(fixture.scope), revision: 0,
    response: { action: 'submit', correlationId: 'question-1', value: { selected: 'accept' } } };
}
