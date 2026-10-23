import { authorizedAnswer, createFixture, fourEventReplay, FixtureRefusal, type ConformanceFixture } from './fakes.js';
import type { ConformanceConsumer } from './neutral-consumer.js';

export * from './fakes.js';
export * from './neutral-consumer.js';

export type ConsumerFactory = (fixture: ConformanceFixture) => ConformanceConsumer;
export interface ConformanceViolation { scenario: string; observation: string }
/** Independent observable-effect oracle; may be used with either host's adapter later. */
export function checkConformance(create: ConsumerFactory): ConformanceViolation[] {
  const violations: ConformanceViolation[] = [];
  const record = (scenario: string, observation: string) => violations.push({ scenario, observation });
  const fixture = createFixture();
  const consumer = create(fixture);
  try {
    consumer.replay(fourEventReplay());
    if (fixture.storage.db.effects.length !== 1) record('duplicate-completed-effect', 'single completion must emit exactly once');
    consumer.replay(fourEventReplay());
    // A distinct result event identity still refers to the same completed call.
    const result = fourEventReplay()[1]!;
    consumer.replay([{ ...result, eventId: 'replayed-result', sequence: 5 }]);
    if (fixture.storage.db.effects.length !== 1) record('duplicate-completed-effect', 'replay emitted a completed effect again');
  } catch (error) { record('duplicate-completed-effect', `positive replay refused: ${String(error)}`); }

  const reject = (scenario: string, input: (f: ConformanceFixture) => unknown, code: string) => {
    const f = createFixture();
    const candidate = create(f);
    let refused = false;
    try { candidate.answer(input(f)); }
    catch (error) { refused = error instanceof FixtureRefusal && error.code === code; }
    if (!refused) record(scenario, `expected typed refusal ${code}`);
    if (f.storage.db.effects.length || f.storage.db.decisions.size) record(scenario, 'refused answer committed a loser effect or decision');
  };
  for (const field of ['tenantId', 'customerId', 'publicOwnerId'] as const) {
    reject('foreign-interaction-answer', f => {
      const answer = authorizedAnswer(f); answer.scope[field] = `foreign-${field}`; return answer;
    }, 'unauthorized');
  }
  for (const malformed of [null, [], {}, { action: 'submit' },
    { action: 'submit', correlationId: 'question-1', value: { selected: 'missing-option' } },
    { action: 'submit', correlationId: 'question-1', value: { selected: ['accept'] } },
    { action: 'submit', correlationId: 'question-1', value: { selected: 'accept', authority: true } }]) {
    reject('malformed-interaction-answer', f => ({ ...authorizedAnswer(f), response: malformed }), 'invalid-frame');
  }
  const f = createFixture();
  try {
    const decision = create(f).answer(authorizedAnswer(f));
    if (decision.correlationId !== 'question-1' || decision.revision !== 1
      || decision.value.selected !== 'accept' || f.storage.db.decisions.size !== 1 || f.storage.db.effects.length !== 1) {
      record('authorized-interaction-answer', 'authorized answer did not commit one terminal decision and effect');
    }
    try { create(f).answer(authorizedAnswer(f)); record('stale-interaction-answer', 'second worker resolved stale revision'); }
    catch (error) { if (!(error instanceof FixtureRefusal) || error.code !== 'stale-revision') record('stale-interaction-answer', 'wrong stale-answer refusal'); }
    if (f.storage.db.effects.length !== 1) record('stale-interaction-answer', 'second worker emitted a loser effect');
  } catch (error) { record('authorized-interaction-answer', `authorized positive control refused: ${String(error)}`); }
  return violations;
}
