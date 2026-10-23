import { describe, expect, it } from 'vitest';
import { InteractionResolver } from '../interaction-resolution.js';
import { interactionAnswer, interactionFixture, interactionIdentity as identity,
  interactionKey, interactionScope as scope, pendingInteraction } from './interaction-fakes.js';

describe('scoped interaction resolution', () => {
  it('accepts one schema-valid answer from the bound principal and conversation and advances once', async () => {
    const f = interactionFixture();
    const unrelated = { ...identity, correlationId: 'unrelated' };
    const untouched = pendingInteraction(unrelated);
    f.storage.db.interactions.set(interactionKey(unrelated), structuredClone(untouched));
    expect(await f.resolver.resolve(identity, scope, interactionAnswer())).toMatchObject({ ok: true,
      value: { submissionId: 'answer-1', revision: 1, response: { value: { selected: 'accept' } } } });
    expect(f.record().status).toBe('resolved');
    expect(f.advances).toHaveLength(1);
    expect(f.storage.db.interactions.get(interactionKey(unrelated))).toEqual(untouched);
  });

  it('allows one of two concurrent answers to win and refuses the loser without a second advance', async () => {
    const f = interactionFixture();
    const results = await Promise.all(['answer-1', 'answer-2'].map(id =>
      f.resolver.resolve(identity, scope, interactionAnswer(id))));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, code: 'already-decided' }]);
    expect(f.advances).toHaveLength(1);
    expect(f.record().decision?.submissionId).toBe(results.find(result => result.ok)?.value.submissionId);
  });

  it('rejects foreign principal conversation tenant customer and public-owner scope', async () => {
    for (const field of ['principalId', 'tenantId', 'customerId', 'publicOwnerId'] as const) {
      const f = interactionFixture();
      expect(await f.resolver.resolve(identity, { ...scope, [field]: 'foreign' }, interactionAnswer()))
        .toEqual({ ok: false, code: 'unauthorized' });
      // Store-side binding must also be enforced, even if a route's ACL accepts the caller.
      f.record().scope[field] = 'foreign';
      expect(await f.resolver.resolve(identity, scope, interactionAnswer())).toEqual({ ok: false, code: 'unauthorized' });
      expect(f.record().status).toBe('pending');
      expect(f.advances).toHaveLength(0);
    }
    const f = interactionFixture();
    const foreign = { ...identity, conversationId: 'foreign' };
    expect(await f.resolver.resolve(foreign, scope, interactionAnswer())).toEqual({ ok: false, code: 'not-found' });
    // Poisoned identity-scoped store response is rejected by the resolver too.
    f.record().conversationId = 'foreign';
    expect(await f.resolver.resolve(identity, scope, interactionAnswer())).toEqual({ ok: false, code: 'unauthorized' });
    expect(f.advances).toHaveLength(0);
  });

  it('rejects malformed and schema-invalid answers', async () => {
    for (const response of [null, [], {}, { action: 'submit', correlationId: 'foreign', value: {} },
      { action: 'submit', correlationId: identity.correlationId, value: [] },
      { action: 'submit', correlationId: identity.correlationId, value: { selected: 'missing' } },
      { action: 'submit', correlationId: identity.correlationId, value: { selected: ['accept'] } },
      { action: 'submit', correlationId: identity.correlationId, value: { selected: 'accept', authority: true } },
      { action: 'submit', correlationId: identity.correlationId, value: { selected: 'accept' }, authorized: true },
      { action: 'decline', correlationId: identity.correlationId }]) {
      const f = interactionFixture();
      expect(await f.resolver.resolve(identity, scope, { ...interactionAnswer(), response }))
        .toEqual({ ok: false, code: 'invalid-answer' });
      expect(f.advances).toHaveLength(0);
      expect(f.record().status).toBe('pending');
    }
    const f = interactionFixture();
    f.adapter.validate = async () => { throw new Error('validator-failed'); };
    expect(await f.resolver.resolve(identity, scope, interactionAnswer())).toEqual({ ok: false, code: 'invalid-answer' });
    expect(f.advances).toHaveLength(0);
  });

  it('refuses expired cancelled late and duplicate answers', async () => {
    for (const time of [100, 101]) {
      const f = interactionFixture();
      f.storage.clock.advance(time);
      expect(await f.resolver.resolve(identity, scope, interactionAnswer())).toEqual({ ok: false, code: 'expired' });
      expect(f.advances).toHaveLength(0);
    }
    const f = interactionFixture();
    f.record().status = 'cancelled';
    expect(await f.resolver.resolve(identity, scope, interactionAnswer())).toEqual({ ok: false, code: 'cancelled' });
    expect(f.advances).toHaveLength(0);
    const valid = interactionFixture();
    valid.storage.clock.advance(99);
    expect((await valid.resolver.resolve(identity, scope, interactionAnswer())).ok).toBe(true);
    for (const id of ['answer-1', 'late-answer']) {
      expect(await valid.resolver.resolve(identity, scope, interactionAnswer(id))).toEqual({ ok: false, code: 'already-decided' });
    }
    expect(valid.advances).toHaveLength(1);
  });

  it('refuses stale revision CAS and authority revoked after render', async () => {
    for (const change of ['revision', 'schema', 'authority', 'scope', 'cancellation', 'expiry']) {
      const f = interactionFixture();
      const validate = f.adapter.validate;
      f.adapter.validate = async (schema, value) => {
        const result = await validate(schema, value);
        if (change === 'revision') f.record().revision++;
        if (change === 'schema') f.record().schema.revision++;
        if (change === 'authority') f.store.authorized = false;
        if (change === 'scope') f.record().scope.publicOwnerId = 'new-owner';
        if (change === 'cancellation') f.record().status = 'cancelled';
        if (change === 'expiry') f.storage.clock.advance(100);
        return result;
      };
      const code = { revision: 'stale-revision', schema: 'stale-revision', authority: 'unauthorized',
        scope: 'unauthorized', cancellation: 'cancelled', expiry: 'expired' }[change];
      expect(await f.resolver.resolve(identity, scope, interactionAnswer())).toEqual({ ok: false, code });
      expect(f.record().decision).toBeUndefined();
      expect(f.advances).toHaveLength(0);
    }
    const f = interactionFixture();
    expect(await f.resolver.resolve(identity, scope, { ...interactionAnswer(), revision: 1 }))
      .toEqual({ ok: false, code: 'stale-revision' });
    // Rendering this legitimate card grants nothing if backend authority has changed.
    const rendered = structuredClone(f.record().spec);
    expect(rendered.prompt).toBeTruthy();
    f.store.authorized = false;
    expect(await f.resolver.resolve(identity, scope, interactionAnswer())).toEqual({ ok: false, code: 'unauthorized' });
    expect(f.advances).toHaveLength(0);
  });

  it('fails closed on unavailable storage and unknown write outcomes', async () => {
    const f = interactionFixture();
    f.store.available = false;
    expect(await f.resolver.resolve(identity, scope, interactionAnswer())).toEqual({ ok: false, code: 'storage-unavailable' });
    f.store.available = true;
    f.store.failBeforeCommit = true;
    expect(await f.resolver.resolve(identity, scope, interactionAnswer())).toEqual({ ok: false, code: 'needs-reconciliation' });
    expect(f.record().status).toBe('pending');
    expect(f.advances).toHaveLength(0);
  });

  it('snapshots caller data before asynchronous validation and supports host value transforms', async () => {
    const f = interactionFixture();
    const input = interactionAnswer();
    const caller = { ...scope };
    f.adapter.validate = async () => {
      input.submissionId = 'changed';
      caller.principalId = 'foreign';
      return { ok: true, value: { selected: 'accept', normalized: true } };
    };
    expect(await new InteractionResolver(f.adapter).resolve(identity, caller, input)).toMatchObject({ ok: true,
      value: { submissionId: 'answer-1', response: { value: { selected: 'accept', normalized: true } } } });
    expect(f.advances).toHaveLength(1);
  });

  it('recovers the last safe terminal revision and refuses counter overflow', async () => {
    const f = interactionFixture();
    f.record().revision = Number.MAX_SAFE_INTEGER - 1;
    const answer = { ...interactionAnswer(), revision: Number.MAX_SAFE_INTEGER - 1 };
    expect(await f.resolver.resolve(identity, scope, answer)).toMatchObject({ ok: true,
      value: { revision: Number.MAX_SAFE_INTEGER } });
    expect(await f.resolver.read(identity, scope)).toMatchObject({ ok: true, value: { status: 'resolved' } });
    expect(f.advances).toHaveLength(1);
    const exhausted = interactionFixture();
    exhausted.record().revision = Number.MAX_SAFE_INTEGER;
    expect(await exhausted.resolver.resolve(identity, scope, { ...answer, revision: Number.MAX_SAFE_INTEGER }))
      .toEqual({ ok: false, code: 'invalid-state' });
    expect(exhausted.record().status).toBe('pending');
    expect(exhausted.advances).toHaveLength(0);
  });
});
