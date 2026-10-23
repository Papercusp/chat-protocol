import { describe, expect, it } from 'vitest';
import { InteractionResolver } from '../interaction-resolution.js';
import { FakeStorage } from './fakes.js';
import { interactionAnswer, interactionFixture, interactionIdentity as identity,
  interactionKey, interactionScope as scope, pendingInteraction } from './interaction-fakes.js';

describe('interaction resolver over existing deterministic card/session seam (tree only)', () => {
  it('commit-success ack-loss recovers one terminal decision without a second workflow advance', async () => {
    const f = interactionFixture();
    f.store.loseNextAcknowledgement = true;
    const result = await f.resolver.resolve(identity, scope, interactionAnswer());
    expect(result).toMatchObject({ ok: true, value: { submissionId: 'answer-1', revision: 1 } });
    const restarted = interactionFixture(new FakeStorage(f.storage.clock, f.storage.db), false);
    expect(await restarted.resolver.read(identity, scope)).toMatchObject({ ok: true,
      value: { status: 'resolved', decision: result.ok ? result.value : undefined } });
    expect(await restarted.resolver.resolve(identity, scope, interactionAnswer())).toEqual({ ok: false, code: 'already-decided' });
    expect(f.advances).toHaveLength(1);
  });

  it('two workers resolve one durable winner and no downstream loser effect', async () => {
    const first = interactionFixture();
    const second = interactionFixture(new FakeStorage(first.storage.clock, first.storage.db), false);
    // Both workers validate the SAME pending revision before either enters its final fence.
    let validations = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    for (const f of [first, second]) {
      const validate = f.adapter.validate;
      f.adapter.validate = async (schema, value) => {
        const result = await validate(schema, value);
        if (++validations === 2) release();
        await barrier;
        return result;
      };
    }
    const unrelated = { ...identity, correlationId: 'unrelated' };
    const untouched = pendingInteraction(unrelated);
    first.storage.db.interactions.set(interactionKey(unrelated), structuredClone(untouched));
    const outcomes = await Promise.all([first.resolver.resolve(identity, scope, interactionAnswer('worker-1')),
      second.resolver.resolve(identity, scope, interactionAnswer('worker-2'))]);
    expect(outcomes.filter(outcome => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter(outcome => !outcome.ok)).toEqual([{ ok: false, code: 'already-decided' }]);
    const winner = outcomes.find(outcome => outcome.ok);
    expect(first.record().decision).toEqual(winner?.value);
    expect(first.advances.map(record => record.decision)).toEqual([winner?.value]);
    expect(first.storage.db.interactions.get(interactionKey(unrelated))).toEqual(untouched);
  });

  it('restart reads pending and terminal decisions from the existing card session seam', async () => {
    const f = interactionFixture();
    const pending = structuredClone(f.record());
    const fresh = interactionFixture(new FakeStorage(f.storage.clock, f.storage.db), false);
    const read = await fresh.resolver.read(identity, scope);
    expect(read).toEqual({ ok: true, value: pending });
    if (read.ok) read.value.scope.principalId = 'changed-snapshot';
    expect(f.record()).toEqual(pending);
    expect((await fresh.resolver.resolve(identity, scope, interactionAnswer())).ok).toBe(true);
    const afterRestart = new InteractionResolver(fresh.adapter);
    expect(await afterRestart.read(identity, scope)).toMatchObject({ ok: true,
      value: { schemaVersion: 1, status: 'resolved', decision: f.record().decision } });
    expect(await afterRestart.read(identity, { ...scope, publicOwnerId: 'foreign' }))
      .toEqual({ ok: false, code: 'unauthorized' });
    expect(f.advances).toHaveLength(1);
  });

  it('ack-loss never acknowledges a competing payload that reused the same submission identity', async () => {
    for (const reuseId of [false, true]) {
    const f = interactionFixture();
    const validate = f.adapter.validate;
    const competing = new InteractionResolver({ ...f.adapter, validate });
    const transact = f.store.transact.bind(f.store);
    f.store.transact = async (identity, caller, decide) => {
      const result = await transact(identity, caller, decide);
      // The refusal acknowledgement is lost after the other worker committed.
      if (!result.ok && result.code === 'already-decided') throw new Error('ack-lost');
      return result;
    };
    f.adapter.validate = async (schema, value) => {
      const valid = await validate(schema, value);
      const other = interactionAnswer(reuseId ? 'answer-1' : 'other-answer');
      other.response = { action: 'submit', correlationId: identity.correlationId, value: { selected: 'reject' } };
      expect((await competing.resolve(identity, scope, other)).ok).toBe(true);
      return valid;
    };
    expect(await f.resolver.resolve(identity, scope, interactionAnswer()))
      .toEqual({ ok: false, code: 'needs-reconciliation' });
    expect(f.record().decision?.response).toMatchObject({ value: { selected: 'reject' } });
    expect(f.advances).toHaveLength(1);
    }
  });

  it('ack-loss recovers a matching normalized answer after storage reorders JSON object keys', async () => {
    const f = interactionFixture();
    f.adapter.validate = async () => ({ ok: true, value: { selected: 'accept', metadata: { b: 2, a: 1 } } });
    const transact = f.store.transact.bind(f.store);
    f.store.transact = (identity, caller, decide) => transact(identity, caller, current => {
      const mutation = decide(current);
      const stored = mutation.next?.decision?.response;
      if (stored?.action === 'submit') stored.value = { metadata: { a: 1, b: 2 }, selected: 'accept' };
      return mutation;
    });
    f.store.loseNextAcknowledgement = true;
    expect(await f.resolver.resolve(identity, scope, interactionAnswer())).toMatchObject({ ok: true,
      value: { response: { value: { selected: 'accept', metadata: { a: 1, b: 2 } } } } });
    expect(f.advances).toHaveLength(1);
  });
});
