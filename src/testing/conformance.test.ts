import { describe, expect, it } from 'vitest';
import { checkConformance } from './conformance.js';
import { authorizedAnswer, createFixture, FakeClock, FakeProvider, FakeStorage, FIXTURE_BUDGETS,
  fourEventReplay, type FixtureCode } from './fakes.js';
import { NeutralConsumer } from './neutral-consumer.js';

function refuses(run: () => unknown, code: FixtureCode) {
  expect(run).toThrow(expect.objectContaining({ code }));
}
describe('reusable conformance detectors', () => {
  it('rejects duplicate-completed-effect on four-event replay while a single completion passes', () => {
    expect(checkConformance(f => new NeutralConsumer(f))).toEqual([]);
    const failures = checkConformance(f => {
      const good = new NeutralConsumer(f);
      return { answer: good.answer.bind(good), replay: events => {
        good.replay(events);
        // Deliberately bad adapter dispatches outside the completed-effect checkpoint.
        f.storage.db.effects.push({ key: 'bad-dispatch', scope: f.scope, result: 'duplicate' });
      } };
    });
    expect(failures).toContainEqual({ scenario: 'duplicate-completed-effect', observation: 'replay emitted a completed effect again' });
    const f = createFixture();
    f.storage.loseNextAcknowledgement = true;
    refuses(() => new NeutralConsumer(f).replay(fourEventReplay()), 'effect-unknown');
    expect(f.storage.db.completed.size).toBe(1);
    // Fresh fake worker uses the committed state, never blindly repeats an ambiguous effect.
    const recovered = { ...f, storage: new FakeStorage(f.clock, f.storage.db) };
    new NeutralConsumer(recovered).replay(fourEventReplay());
    expect(f.storage.db.effects).toHaveLength(1);
  });
  it('refuses foreign and malformed interaction answers while the authorized answer passes', () => {
    expect(checkConformance(f => new NeutralConsumer(f))).toEqual([]);
    const foreign = checkConformance(f => {
      const good = new NeutralConsumer(f);
      return { replay: good.replay.bind(good), answer: () => good.answer(authorizedAnswer(f)) };
    });
    expect(foreign.some(v => v.scenario === 'foreign-interaction-answer')).toBe(true);
    expect(foreign.some(v => v.scenario === 'malformed-interaction-answer')).toBe(true);
    const f = createFixture();
    f.authorized = false;
    refuses(() => new NeutralConsumer(f).answer(authorizedAnswer(f)), 'unauthorized');
    expect(f.storage.db.effects).toHaveLength(0);
  });
  it('enforces retry deadline expiry replay and context budgets with deterministic fakes', () => {
    expect(FIXTURE_BUDGETS).toEqual({ retryAttempts: 2, backoffMs: 10, deadlineMs: 100,
      replayEvents: 4, interactionExpiryMs: 100, contextTokens: 256 });
    for (const tokens of [255, 256]) {
      const clock = new FakeClock();
      const p = new FakeProvider(clock, [{ delayMs: 1, failure: 'retryable' },
        { delayMs: 1, failure: 'retryable' }, { delayMs: 1, text: 'document' }]);
      expect(p.run(tokens)).toBe('document'); expect(p.calls).toBe(3); expect(clock.now).toBe(23);
    }
    const overContext = new FakeProvider(new FakeClock(), [{ delayMs: 0, text: 'no' }]);
    refuses(() => overContext.run(257), 'context-budget'); expect(overContext.calls).toBe(0);
    const exhausted = new FakeProvider(new FakeClock(), Array.from({ length: 4 }, () => ({ delayMs: 0, failure: 'retryable' as const })));
    refuses(() => exhausted.run(1), 'retry-exhausted'); expect(exhausted.calls).toBe(3);
    expect(new FakeProvider(new FakeClock(), [{ delayMs: 99, text: 'yes' }]).run(1)).toBe('yes');
    for (const delayMs of [100, 101]) {
      refuses(() => new FakeProvider(new FakeClock(), [{ delayMs, text: 'late' }]).run(1), 'deadline-exceeded');
    }
    const backoff = new FakeClock();
    const deadline = new FakeProvider(backoff, [{ delayMs: 90, failure: 'retryable' }, { delayMs: 0, text: 'late' }]);
    refuses(() => deadline.run(1), 'deadline-exceeded'); expect(deadline.calls).toBe(1); expect(backoff.now).toBe(100);
    for (const time of [99, 100, 101]) {
      const f = createFixture(); f.clock.advance(time);
      if (time < 100) expect(new NeutralConsumer(f).answer(authorizedAnswer(f)).revision).toBe(1);
      else { refuses(() => new NeutralConsumer(f).answer(authorizedAnswer(f)), 'interaction-expired'); expect(f.storage.db.effects).toHaveLength(0); }
    }
    const f = createFixture();
    fourEventReplay().forEach(event => f.storage.append(event));
    expect(f.storage.replay(0)).toHaveLength(4);
    f.storage.append({ ...fourEventReplay()[3], eventId: 'event-5', sequence: 5 });
    refuses(() => f.storage.replay(0), 'replay-expired');
    expect(f.storage.replay(1).map(e => e.sequence)).toEqual([2, 3, 4, 5]);
    const unavailable = createFixture(); unavailable.storage.available = false;
    refuses(() => new NeutralConsumer(unavailable).answer(authorizedAnswer(unavailable)), 'storage-unavailable');
    expect(unavailable.storage.db.effects).toHaveLength(0); expect(unavailable.storage.db.decisions.size).toBe(0);
    const slow = createFixture(); slow.storage.commitDelayMs = 100;
    refuses(() => new NeutralConsumer(slow).answer(authorizedAnswer(slow)), 'deadline-exceeded');
    expect(slow.storage.db.decisions.size).toBe(0);
    const inBudget = createFixture(); inBudget.storage.commitDelayMs = 60;
    expect(new NeutralConsumer(inBudget).answer(authorizedAnswer(inBudget)).revision).toBe(1);
    expect(inBudget.clock.now).toBe(60);
    expect(inBudget.storage.db.effects).toHaveLength(1);
  });
});
