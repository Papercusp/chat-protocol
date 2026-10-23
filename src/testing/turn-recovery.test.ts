import { describe, expect, it } from 'vitest';
import { TurnRecovery } from '../turn-recovery.js';
import { durableCapabilities, lightweightCapabilities, recoveryFixture, recoveryIdentity as turn } from './recovery-fakes.js';

describe('turn recovery contract', () => {
  it('reuses a known completed result without dispatch and preserves turn and effect identity', async () => {
    const f = recoveryFixture();
    expect((await f.worker.start(turn, ['read-1'])).ok).toBe(true);
    const first = await f.worker.runEffect(turn, 'read-1', f.dispatch, f.control.signal);
    expect(first).toEqual({ ok: true, value: { ...turn, effectId: 'read-1',
      result: { ref: 'document:1', text: 'Stored document' }, source: 'dispatch' } });
    expect(await f.worker.recover(turn, 'read-1')).toEqual({ ...first,
      value: first.ok ? { ...first.value, source: 'checkpoint' } : undefined });
    expect(await f.worker.runEffect(turn, 'read-1', f.dispatch, f.control.signal)).toMatchObject({
      ok: true, value: { ...turn, effectId: 'read-1', source: 'checkpoint' },
    });
    expect(f.calls).toEqual([{ ...turn, effectId: 'read-1' }]);
    expect((await f.store.read(turn))?.state.phase).toBe('completed');
  });

  it('returns needs-reconciliation for an ambiguous external outcome without dispatch', async () => {
    const f = recoveryFixture();
    await f.worker.start(turn, ['read-1']);
    const unknown = await f.worker.runEffect(turn, 'read-1', async input => {
      await f.dispatch(input); // Remote effect committed, but its result never reached the worker.
      throw new Error('connection-lost');
    }, f.control.signal);
    expect(unknown).toEqual({ ok: false, code: 'needs-reconciliation' });
    expect(await f.worker.recover(turn, 'read-1')).toEqual(unknown);
    expect(await f.worker.runEffect(turn, 'read-1', f.dispatch, f.control.signal)).toEqual(unknown);
    expect(f.calls).toHaveLength(1);
    expect((await f.store.read(turn))?.effects['read-1'].status).toBe('dispatching');
  });

  it('refuses restart recovery for a lightweight profile', async () => {
    const f = recoveryFixture(lightweightCapabilities);
    await f.worker.start(turn, ['read-1']);
    expect(await f.worker.recover(turn, 'read-1')).toEqual({ ok: false, code: 'restart-recovery-unsupported' });
    // A later worker advertising more capabilities cannot upgrade an old lightweight checkpoint.
    const upgraded = new TurnRecovery({ ...f.adapter, capabilities: durableCapabilities });
    expect(await upgraded.recover(turn, 'read-1')).toEqual({ ok: false, code: 'restart-recovery-unsupported' });
    expect(f.calls).toHaveLength(0);
  });

  it('replays four ordered events after a valid cursor and preserves cancellation semantics', async () => {
    const f = recoveryFixture();
    f.seedReplay();
    await f.worker.start(turn, ['read-1']);
    const replay = await f.worker.replay(turn, 0);
    expect(replay.ok && replay.value.map(event => [event.turnId, event.sequence])).toEqual([
      [turn.turnId, 1], [turn.turnId, 2], [turn.turnId, 3], [turn.turnId, 4],
    ]);
    expect((await f.worker.cancel(turn)).ok).toBe(true);
    expect(f.control.signal.aborted).toBe(true);
    expect(await f.worker.runEffect(turn, 'read-1', f.dispatch, f.control.signal)).toEqual({ ok: false, code: 'cancelled' });
    expect(await f.worker.replay(turn, 0)).toEqual(replay);
    expect(await f.worker.replay(turn, 4)).toEqual({ ok: true, value: [] });
    expect(f.calls).toHaveLength(0);
  });

  it('surfaces checkpoint-write failure without marking completion', async () => {
    const f = recoveryFixture();
    await f.worker.start(turn, ['read-1']);
    f.store.failCompletion = true;
    expect(await f.worker.runEffect(turn, 'read-1', f.dispatch, f.control.signal))
      .toEqual({ ok: false, code: 'checkpoint-write-failed' });
    const record = await f.store.read(turn);
    expect(record?.state.phase).toBe('running');
    expect(record?.effects['read-1'].status).toBe('dispatching');
    expect(await f.worker.recover(turn, 'read-1')).toEqual({ ok: false, code: 'needs-reconciliation' });
    expect(await f.worker.runEffect(turn, 'read-1', f.dispatch, f.control.signal))
      .toEqual({ ok: false, code: 'needs-reconciliation' });
    expect(f.calls).toHaveLength(1);
  });

  it('rejects reordered, missing, duplicate and foreign replay frames and stale or future cursors', async () => {
    const f = recoveryFixture();
    f.seedReplay();
    const events = f.events.db.events;
    for (const frames of [[events[1], events[0], events[2], events[3]], events.slice(1),
      [events[0], { ...events[1], eventId: events[0].eventId }, events[2], events[3]],
      [{ ...events[0], turnId: 'foreign-turn' }, ...events.slice(1)]]) {
      const worker = new TurnRecovery({ ...f.adapter, async replay() {
        return { lastSequence: 4, firstAvailableSequence: 1, events: frames };
      } });
      expect(await worker.replay(turn, 0)).toEqual({ ok: false, code: 'invalid-cursor' });
    }
    for (const cursor of [-1, 0.5, 5, Number.NaN]) {
      expect(await f.worker.replay(turn, cursor)).toEqual({ ok: false, code: 'invalid-cursor' });
    }
    const expired = new TurnRecovery({ ...f.adapter, async replay() {
      return { lastSequence: 4, firstAvailableSequence: 2, events: events.slice(1) };
    } });
    expect(await expired.replay(turn, 0)).toEqual({ ok: false, code: 'replay-expired' });
    expect(await expired.replay(turn, 1)).toMatchObject({ ok: true, value: events.slice(1) });
  });

  it('requires current host authority and refuses unregistered effect or foreign turn identities', async () => {
    const f = recoveryFixture();
    await f.worker.start(turn, ['read-1']);
    f.authorized = false;
    expect(await f.worker.runEffect(turn, 'read-1', f.dispatch, f.control.signal)).toEqual({ ok: false, code: 'unauthorized' });
    expect(await f.worker.cancel(turn)).toEqual({ ok: false, code: 'unauthorized' });
    expect(await f.worker.replay(turn, 0)).toEqual({ ok: false, code: 'unauthorized' });
    expect(await f.worker.recover(turn, 'read-1')).toEqual({ ok: false, code: 'unauthorized' });
    f.authorized = true;
    expect(await f.worker.runEffect(turn, '__proto__', f.dispatch, f.control.signal)).toEqual({ ok: false, code: 'unauthorized' });
    expect(await f.worker.start({ ...turn, conversationId: 'foreign-conversation' }, ['read-1']))
      .toEqual({ ok: false, code: 'unauthorized' });
    expect(f.calls).toHaveLength(0);
  });

  it('fails closed on unavailable or malformed checkpoint state and uncertain claim acknowledgement', async () => {
    const f = recoveryFixture();
    await f.worker.start(turn, ['read-1']);
    f.store.available = false;
    expect(await f.worker.runEffect(turn, 'read-1', f.dispatch, f.control.signal))
      .toEqual({ ok: false, code: 'storage-unavailable' });
    f.store.available = true;
    f.store.loseClaimAcknowledgement = true;
    expect(await f.worker.runEffect(turn, 'read-1', f.dispatch, f.control.signal))
      .toEqual({ ok: false, code: 'needs-reconciliation' });
    expect(await f.worker.runEffect(turn, 'read-1', f.dispatch, f.control.signal))
      .toEqual({ ok: false, code: 'needs-reconciliation' });
    expect(f.calls).toHaveLength(0);
    const record = await f.store.read(turn);
    if (!record) throw new Error('missing fixture');
    record.state.schemaVersion = 99 as 1;
    const worker = new TurnRecovery({ ...f.adapter, store: { ...f.store,
      async read() { return record; }, compareAndSwap: f.store.compareAndSwap.bind(f.store),
    } });
    expect(await worker.recover(turn, 'read-1')).toEqual({ ok: false, code: 'invalid-state' });
  });
});
