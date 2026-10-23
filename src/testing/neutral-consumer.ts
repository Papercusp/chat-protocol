import { parseChatEnvelope, type ChatEventEnvelope } from '../index.js';
import { FixtureRefusal, sameScope, type ConformanceFixture, type FixtureAnswer, type TerminalDecision } from './fakes.js';

export interface ConformanceConsumer {
  replay(events: readonly unknown[]): void;
  answer(input: unknown): TerminalDecision;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Runnable document-reader fixture. Only protocol contracts/fakes; no host business imports. */
export class NeutralConsumer implements ConformanceConsumer {
  readonly events: ChatEventEnvelope[] = [];
  constructor(readonly fixture: ConformanceFixture) {}
  replay(events: readonly unknown[]): void {
    for (const input of events) {
      const parsed = parseChatEnvelope(input);
      if (!parsed.ok) throw new FixtureRefusal('invalid-frame');
      const frame = parsed.value;
      this.events.push(frame);
      if (frame.event.type === 'tool_result' && frame.event.ok) {
        this.fixture.storage.complete({
          key: JSON.stringify([frame.conversationId, frame.turnId, frame.event.callId]),
          scope: this.fixture.scope, result: frame.event,
        });
      }
    }
  }
  answer(input: unknown): TerminalDecision {
    if (!object(input) || !object(input.scope) || !object(input.response)
      || !Number.isSafeInteger(input.revision) || (input.revision as number) < 0
      || input.response.action !== 'submit' || typeof input.response.correlationId !== 'string'
      || !object(input.response.value) || typeof input.response.value.selected !== 'string'
      || Object.keys(input.response.value).some(key => key !== 'selected')) {
      throw new FixtureRefusal('invalid-frame');
    }
    const scope = input.scope;
    if (['tenantId', 'customerId', 'publicOwnerId'].some(key => typeof scope[key] !== 'string' || scope[key] === '')) {
      throw new FixtureRefusal('invalid-frame');
    }
    const answer = input as unknown as FixtureAnswer;
    const response = answer.response;
    if (response.action !== 'submit') throw new FixtureRefusal('invalid-frame');
    const pending = this.fixture.storage.db.pending.get(response.correlationId);
    // Authority is re-read at answer time, never inherited from rendered content or answer claims.
    if (!pending || !this.fixture.authorized || !sameScope(this.fixture.scope, answer.scope)
      || !sameScope(pending.scope, answer.scope)) throw new FixtureRefusal('unauthorized');
    if (this.fixture.clock.now >= pending.expiresAt) throw new FixtureRefusal('interaction-expired');
    if (pending.revision !== answer.revision) throw new FixtureRefusal('stale-revision');
    if (!pending.spec.presentation?.options?.some(option => option.id === response.value.selected)) {
      throw new FixtureRefusal('invalid-frame');
    }
    return this.fixture.storage.decide(response.correlationId, answer.revision, response.value);
  }
}
