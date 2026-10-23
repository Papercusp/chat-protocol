import { describe, expect, it } from 'vitest';
import { TurnRecovery } from '../turn-recovery.js';
import { RecoveryStorage, lightweightCapabilities, recoveryFixture, recoveryIdentity as turn } from './recovery-fakes.js';

describe('turn recovery across worker boundaries (deterministic host fakes)', () => {
  it('durable fake survives worker replacement and reuses the completed result', async () => {
    const first = recoveryFixture();
    await first.worker.start(turn, ['read-1']);
    expect((await first.worker.runEffect(turn, 'read-1', first.dispatch, first.control.signal)).ok).toBe(true);
    first.seedReplay();
    const replacement = recoveryFixture(undefined, new RecoveryStorage(first.store.records), first.events);
    expect(replacement.control).not.toBe(first.control);
    expect(await replacement.worker.recover(turn, 'read-1')).toEqual({ ok: true, value: {
      ...turn, effectId: 'read-1', result: { ref: 'document:1', text: 'Stored document' }, source: 'checkpoint',
    } });
    expect((await replacement.worker.replay(turn, 0)).ok).toBe(true);
    expect(await replacement.worker.runEffect(turn, 'read-1', replacement.dispatch, replacement.control.signal))
      .toMatchObject({ ok: true, value: { source: 'checkpoint' } });
    expect(first.calls).toHaveLength(1);
    expect(replacement.calls).toHaveLength(0);
  });

  it('commit-success ack-loss reconciles by read without redispatch', async () => {
    const f = recoveryFixture();
    await f.worker.start(turn, ['read-1']);
    f.store.loseCompletionAcknowledgement = true;
    const readsBefore = f.store.reads;
    expect(await f.worker.runEffect(turn, 'read-1', f.dispatch, f.control.signal))
      .toMatchObject({ ok: true, value: { ...turn, effectId: 'read-1', source: 'checkpoint' } });
    expect(f.store.reads).toBeGreaterThan(readsBefore);
    const replacement = recoveryFixture(undefined, new RecoveryStorage(f.store.records));
    expect((await replacement.worker.recover(turn, 'read-1')).ok).toBe(true);
    expect((await replacement.store.read(turn))?.state.phase).toBe('completed');
    expect(f.calls).toHaveLength(1);
    expect(replacement.calls).toHaveLength(0);
  });

  it('lightweight adapter preserves connection replay but refuses interrupted-turn recovery', async () => {
    const f = recoveryFixture(lightweightCapabilities);
    await f.worker.start(turn, ['read-1']);
    f.seedReplay();
    const replay = await f.worker.replay(turn, 0);
    expect(replay.ok && replay.value.map(event => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(await f.worker.recover(turn, 'read-1')).toEqual({ ok: false, code: 'restart-recovery-unsupported' });
    const replacement = recoveryFixture(lightweightCapabilities);
    expect(await replacement.worker.recover(turn, 'read-1')).toEqual({ ok: false, code: 'restart-recovery-unsupported' });
    expect(f.calls).toHaveLength(0);
    expect(replacement.calls).toHaveLength(0);
  });

  it('two workers race one pending effect and dispatch exactly once', async () => {
    const f = recoveryFixture();
    const second = new TurnRecovery(f.adapter);
    await f.worker.start(turn, ['read-1']);
    const results = await Promise.all([
      f.worker.runEffect(turn, 'read-1', f.dispatch, f.control.signal),
      second.runEffect(turn, 'read-1', f.dispatch, f.control.signal),
    ]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, code: 'conflict' }]);
    expect(f.calls).toHaveLength(1);
    expect((await f.store.read(turn))?.state.phase).toBe('completed');
  });

  it('cancellation during dispatch aborts execution and retains the completed effect for recovery', async () => {
    const f = recoveryFixture();
    await f.worker.start(turn, ['read-1']);
    const result = await f.worker.runEffect(turn, 'read-1', async input => {
      const completed = await f.dispatch(input);
      expect((await f.worker.cancel(turn)).ok).toBe(true);
      expect(input.signal.aborted).toBe(true);
      return completed;
    }, f.control.signal);
    expect(result).toEqual({ ok: false, code: 'cancelled' });
    expect((await f.store.read(turn))?.state.phase).toBe('cancelled');
    expect(await f.worker.recover(turn, 'read-1')).toMatchObject({ ok: true, value: { source: 'checkpoint' } });
    expect(f.calls).toHaveLength(1);
  });

  it('different authorized effects on one turn both progress through concurrent CAS revisions', async () => {
    const f = recoveryFixture();
    const worker = new TurnRecovery({ ...f.adapter, async authorize() { return true; } });
    await worker.start(turn, ['read-1', 'read-2']);
    const results = await Promise.all(['read-1', 'read-2'].map(effectId =>
      worker.runEffect(turn, effectId, f.dispatch, f.control.signal)));
    expect(results.every(result => result.ok)).toBe(true);
    expect(f.calls.map(call => call.effectId).sort()).toEqual(['read-1', 'read-2']);
    expect((await f.store.read(turn))?.state.phase).toBe('completed');
  });

  it('cancellation after the atomic claim prevents dispatch', async () => {
    const f = recoveryFixture();
    const cas = f.store.compareAndSwap.bind(f.store);
    f.store.compareAndSwap = async (identity, revision, next) => {
      const saved = await cas(identity, revision, next);
      if (saved && next.effects['read-1'].status === 'dispatching' && next.state.phase === 'running') {
        expect((await f.worker.cancel(identity)).ok).toBe(true);
      }
      return saved;
    };
    await f.worker.start(turn, ['read-1']);
    expect(await f.worker.runEffect(turn, 'read-1', f.dispatch, f.control.signal)).toEqual({ ok: false, code: 'cancelled' });
    expect(f.calls).toHaveLength(0);
  });

  it('cancellation committed during final authorization prevents dispatch before abort propagation', async () => {
    const f = recoveryFixture();
    let dispatchAuthorizations = 0;
    let cancellation: ReturnType<TurnRecovery['cancel']> | undefined;
    let releaseAbort!: () => void;
    let enteredAbort!: () => void;
    const abortEntered = new Promise<void>(resolve => { enteredAbort = resolve; });
    const abortReleased = new Promise<void>(resolve => { releaseAbort = resolve; });
    const worker = new TurnRecovery({ ...f.adapter,
      async authorize(action, identity, effectId) {
        const allowed = await f.adapter.authorize(action, identity, effectId);
        if (action === 'dispatch' && ++dispatchAuthorizations === 2) {
          cancellation = worker.cancel(turn);
          await abortEntered;
          expect((await f.store.read(turn))?.state.phase).toBe('cancelled');
          expect(f.control.signal.aborted).toBe(false);
        }
        return allowed;
      },
      async abortExecution() {
        enteredAbort();
        await abortReleased;
        f.control.abort();
      },
    });
    await worker.start(turn, ['read-1']);
    let outcome;
    try { outcome = await worker.runEffect(turn, 'read-1', f.dispatch, f.control.signal); }
    finally { releaseAbort(); await cancellation; }
    expect(outcome).toEqual({ ok: false, code: 'cancelled' });
    expect(f.calls).toHaveLength(0);
    expect((await f.store.read(turn))?.effects['read-1'].status).toBe('dispatching');
  });
});
