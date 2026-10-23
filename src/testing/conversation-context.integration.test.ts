import { describe, expect, it } from 'vitest';
import { ConversationContext } from '../conversation-context.js';
import { contextHost, contextPolicy, contextRecord, contextScope } from './conversation-context-fakes.js';

describe('conversation context host composition (tree only)', () => {
  it('reuses host-owned summary persistence and usage hooks without taking application authority', async () => {
    const f = contextHost();
    const history = f.get().history;
    const r = await new ConversationContext(f.host).compact(contextScope, 'fold', contextPolicy);
    expect(r.ok).toBe(true);
    expect(f.host.authorize).toHaveBeenCalledWith(contextScope);
    expect(f.host.summarize.mock.calls[0][0]).toMatchObject({ scope: contextScope, operationId: 'fold' });
    expect(f.get().history).toEqual(history);
    expect(f.usageJournal.get('fold')?.usage?.costUsd).toBe(0.001);
    const denied = contextHost();
    denied.host.authorize.mockResolvedValue(false);
    expect(await new ConversationContext(denied.host).compact(contextScope, 'denied', contextPolicy))
      .toMatchObject({ ok: false, code: 'unauthorized' });
    expect(denied.host.summarize).not.toHaveBeenCalled();
    expect(denied.host.compareAndSwap).not.toHaveBeenCalled();
  });

  it('recovers a completed compaction from the existing durable context checkpoint', async () => {
    const f = contextHost();
    const first = await new ConversationContext(f.host).compact(contextScope, 'fold', contextPolicy);
    expect(first.ok).toBe(true);
    const restarted = await new ConversationContext(f.host).recover(contextScope, contextPolicy);
    expect(restarted).toMatchObject({ ok: true, value: { outcome: 'recovered' } });
    if (first.ok && restarted.ok) expect(restarted.value.checkpoint).toEqual(first.value.checkpoint);
    expect(f.host.summarize).toHaveBeenCalledTimes(1);
    expect(f.host.reconcile).not.toHaveBeenCalled();
  });

  it('fails closed on stale context CAS without losing housekeeping usage', async () => {
    const f = contextHost();
    const cas = f.host.compareAndSwap.getMockImplementation()!;
    f.host.compareAndSwap.mockImplementation(async (scope, revision, next) => {
      if (next.operation?.phase === 'completed') {
        const newer = f.get(); newer.revision++; newer.sourceVersion = 'source-2'; f.set(newer); return false;
      }
      return cas(scope, revision, next);
    });
    const r = await new ConversationContext(f.host).compact(contextScope, 'fold', contextPolicy);
    expect(r).toMatchObject({ ok: false, code: 'conflict', receipts: [{ usage: { inputTokens: 17, costUsd: 0.001 } }] });
    expect(f.get().summary).toBeNull();
    expect(f.usageJournal.get('fold')?.usage?.costUsd).toBe(0.001);
    expect(f.host.summarize).toHaveBeenCalledTimes(1);
  });

  it('reconciles a crash during compaction before repeating summary or context writes', async () => {
    const f = contextHost();
    const cas = f.host.compareAndSwap.getMockImplementation()!;
    let crash = true;
    f.host.compareAndSwap.mockImplementation(async (scope, revision, next) => {
      if (next.operation?.phase === 'completed' && crash) { crash = false; throw new Error('process lost before context commit'); }
      return cas(scope, revision, next);
    });
    expect(await new ConversationContext(f.host).compact(contextScope, 'fold', contextPolicy))
      .toMatchObject({ ok: false, code: 'needs-reconciliation' });
    const before = f.host.compareAndSwap.mock.calls.length;
    const remembered = f.providerJournal.get('fold')!;
    f.providerJournal.delete('fold');
    expect(await new ConversationContext(f.host).recover(contextScope, contextPolicy))
      .toMatchObject({ ok: false, code: 'needs-reconciliation' });
    expect(f.host.compareAndSwap).toHaveBeenCalledTimes(before);
    f.providerJournal.set('fold', remembered);
    f.trace.length = 0;
    expect(await new ConversationContext(f.host).recover(contextScope, contextPolicy))
      .toMatchObject({ ok: true, value: { outcome: 'recovered' } });
    expect(f.trace[0]).toBe('reconcile');
    expect(f.trace.at(-1)).toBe('cas:completed');
    expect(f.host.summarize).toHaveBeenCalledTimes(1);
    expect(f.usageJournal.size).toBe(1);
    expect(f.get().receipts).toHaveLength(1);
  });

  it('limited context profiles refuse unsupported restart recovery', async () => {
    const f = contextHost(); f.host.profile = 'limited';
    expect(await new ConversationContext(f.host).recover(contextScope, contextPolicy))
      .toMatchObject({ ok: false, code: 'restart-recovery-unsupported' });
    expect(f.host.read).not.toHaveBeenCalled();
    expect(f.host.summarize).not.toHaveBeenCalled();
  });

  it('refuses foreign session context and summary coverage references', async () => {
    const foreign = contextHost();
    const s = foreign.get(); s.history[0].scope.ownerId = 'another-owner'; foreign.set(s);
    expect(await new ConversationContext(foreign.host).compact(contextScope, 'fold', contextPolicy))
      .toMatchObject({ ok: false, code: 'invalid-context' });
    expect(foreign.host.summarize).not.toHaveBeenCalled();
    const wrongSummary = contextHost();
    wrongSummary.host.summarize.mockResolvedValue({ status: 'completed', text: 'foreign', coveredIds: ['another-session-id'], usage: { inputTokens: 4 } });
    expect(await new ConversationContext(wrongSummary.host).compact(contextScope, 'fold', contextPolicy))
      .toMatchObject({ ok: false, code: 'invalid-summary' });
    expect(wrongSummary.get().summary).toBeNull();
    expect(wrongSummary.usageJournal.get('fold')?.usage).toEqual({ inputTokens: 4 });
    const badStored = contextHost(); const stored = badStored.get();
    stored.summary = { scope: { ...contextScope, conversationId: 'foreign' }, text: 'bad', coveredIds: ['old-a'], operationId: 'prior' };
    badStored.set(stored);
    expect(await new ConversationContext(badStored.host).recover(contextScope, contextPolicy))
      .toMatchObject({ ok: false, code: 'invalid-summary' });
  });

  it('repeated durable compaction is idempotent across restarted adapters', async () => {
    const f = contextHost();
    await new ConversationContext(f.host).compact(contextScope, 'fold', contextPolicy);
    for (const operation of ['fold', 'new-id-for-unchanged-input']) {
      expect(await new ConversationContext(f.host).compact(contextScope, operation, contextPolicy))
        .toMatchObject({ ok: true, value: { outcome: 'unchanged' } });
    }
    expect(f.host.summarize).toHaveBeenCalledTimes(1);
    expect(f.get().receipts).toHaveLength(1);
    const changed = f.get(); changed.sourceVersion = 'source-2'; changed.revision++;
    changed.history.at(-1)!.text = 'old question'.repeat(200);
    changed.history.push(contextRecord('new-latest', 'new question', 'user')); f.set(changed);
    expect(await new ConversationContext(f.host).compact(contextScope, 'fold-2', contextPolicy)).toMatchObject({ ok: true });
    expect(f.host.summarize).toHaveBeenCalledTimes(2);
    expect(f.host.summarize.mock.calls[1][0].records.map(m => m.id)).toEqual(['latest']);
    expect(f.get().summary?.coveredIds).toEqual(['old-a', 'old-b', 'latest']);
    expect(f.usageJournal.size).toBe(2);
  });
});
