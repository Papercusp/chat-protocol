import { describe, expect, it } from 'vitest';
import { ConversationContext, estimateContextTokens, selectConversationContext, type ContextSummary, type SummaryAttempt } from '../conversation-context.js';
import { contextHost, contextPolicy, contextRecord, contextScope } from './conversation-context-fakes.js';

describe('budgeted conversation context contract', () => {
  it('refuses invalid budgets and admits history at below exact and above boundaries', () => {
    const history = [contextRecord('boundary', 'question', 'user')];
    for (const budgetTokens of [0, -1, NaN, Infinity, 1.5])
      expect(selectConversationContext(contextScope, history, { budgetTokens })).toMatchObject({ ok: false, code: 'invalid-budget' });
    for (const cost of [255, 256, 257]) {
      const result = selectConversationContext(contextScope, history, { budgetTokens: 256, estimate: () => cost });
      if (cost <= 256) expect(result).toMatchObject({ ok: true, value: { estimatedTokens: cost, omittedIds: [] } });
      else expect(result).toMatchObject({ ok: false, code: 'budget-exceeded' });
    }
    expect(selectConversationContext(contextScope, history, { budgetTokens: 256, estimate: () => NaN }))
      .toMatchObject({ ok: false, code: 'invalid-budget' });
  });

  it('keeps every admitted completed tool call and result as one unit across multiple calls', () => {
    const history = [contextRecord('calls-ab', 'payload'.repeat(300), 'assistant', { callIds: ['a', 'b'] }),
      contextRecord('between'), contextRecord('result-a', 'A', 'tool', { resultIds: ['a'] }),
      contextRecord('call-c', 'C', 'assistant', { callIds: ['c'] }),
      contextRecord('results-bc', 'B/C', 'tool', { resultIds: ['b', 'c'] }), contextRecord('latest', 'question', 'user')];
    for (const budgetTokens of [256, 4096]) {
      const r = selectConversationContext(contextScope, history, { budgetTokens });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      for (const call of ['a', 'b', 'c']) {
        const calls = r.value.messages.filter(m => m.callIds?.includes(call));
        const results = r.value.messages.filter(m => m.resultIds?.includes(call));
        expect(calls.length).toBe(results.length);
      }
      expect(r.value.estimatedTokens).toBeLessThanOrEqual(budgetTokens);
      if (budgetTokens === 4096) expect(r.value.messages.map(m => m.id)).toEqual(history.map(m => m.id));
    }
    expect(selectConversationContext(contextScope, history.filter(m => m.id !== 'result-a'), contextPolicy))
      .toMatchObject({ ok: false, code: 'invalid-context' });
  });

  it('charges omission and coverage references to the complete context envelope', () => {
    const history = Array.from({ length: 1000 }, (_, i) => contextRecord(`omitted-${i}`, 'x'.repeat(700)));
    history.push(contextRecord('latest', 'question', 'user'));
    expect(selectConversationContext(contextScope, history, contextPolicy))
      .toMatchObject({ ok: false, code: 'budget-exceeded' });
    const small = history.slice(0, 5).concat(history.at(-1)!);
    const summary: ContextSummary = { scope: contextScope, text: 'summary', coveredIds: [small[0].id], operationId: 'prior' };
    const selected = selectConversationContext(contextScope, small, { budgetTokens: 512 }, summary);
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    const { estimatedTokens, ...envelope } = selected.value;
    expect(envelope.omittedIds.length).toBeGreaterThan(0);
    expect(envelope.summaryCoveredIds).toEqual([small[0].id]);
    const exact = estimateContextTokens(JSON.stringify(envelope));
    expect(estimatedTokens).toBe(exact);
    expect(exact).toBeLessThanOrEqual(512);
    const boundary = [contextRecord('latest', 'question', 'user')];
    const one = selectConversationContext(contextScope, boundary, { budgetTokens: 512 });
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    const { estimatedTokens: ignored, ...oneEnvelope } = one.value;
    const oneCost = estimateContextTokens(JSON.stringify(oneEnvelope));
    for (const budgetTokens of [oneCost - 1, oneCost, oneCost + 1]) {
      expect(selectConversationContext(contextScope, boundary, { budgetTokens }).ok).toBe(budgetTokens >= oneCost);
    }
  });

  it('preserves stable pair references and explicit omitted payload provenance', () => {
    const history = [contextRecord('call', 'sensitive payload'.repeat(100), 'assistant', { callIds: ['action'] }),
      contextRecord('result', 'full result'.repeat(100), 'tool', { resultIds: ['action'] })];
    const before = structuredClone(history);
    const r = selectConversationContext(contextScope, history, { budgetTokens: 256, maxMessageChars: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.messages.map(m => [m.id, m.callIds, m.resultIds, m.provenance])).toEqual(
      history.map(m => [m.id, m.callIds, m.resultIds, m.provenance]));
    for (const m of r.value.messages) {
      expect(m.payload.retainedChars).toBe(2);
      expect(m.payload.originalChars).toBeGreaterThan(m.payload.retainedChars);
    }
    expect(history).toEqual(before);
  });

  it('fails closed when mandatory context cannot fit the hard budget', () => {
    const history = [contextRecord('system', 'mandatory'.repeat(600), 'system'), contextRecord('latest', 'question', 'user')];
    expect(selectConversationContext(contextScope, history, contextPolicy)).toMatchObject({ ok: false, code: 'budget-exceeded' });
    const small = [contextRecord('old'), contextRecord('latest', 'question', 'user')];
    const summary: ContextSummary = { scope: contextScope, text: 'summary'.repeat(600), coveredIds: ['old'], operationId: 'prior' };
    expect(selectConversationContext(contextScope, small, contextPolicy, summary)).toMatchObject({ ok: false, code: 'budget-exceeded' });
    const malformed = { ...summary, coveredIds: 42 } as unknown as ContextSummary;
    expect(() => selectConversationContext(contextScope, small, contextPolicy, malformed)).not.toThrow();
    expect(selectConversationContext(contextScope, small, contextPolicy, malformed))
      .toMatchObject({ ok: false, code: 'invalid-summary' });
  });

  it('records successful summary coverage only for its declared source span', async () => {
    const f = contextHost();
    const r = await new ConversationContext(f.host).compact(contextScope, 'fold', contextPolicy);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.checkpoint.summary?.coveredIds).toEqual(['old-a', 'old-b']);
    expect(r.value.selection.messages.map(m => m.id)).toEqual(['latest']);
    expect(r.value.selection.omittedIds).toEqual([]);
    expect(r.value.selection.estimatedTokens).toBeLessThanOrEqual(256);
    expect(f.host.summarize.mock.calls[0][0].records.map(m => m.id)).toEqual(['old-a', 'old-b']);
    expect(r.value.checkpoint.history).toEqual(f.get().history);
  });

  it('keeps failed or incomplete summaries out of remembered coverage', async () => {
    for (const status of ['failed', 'incomplete', 'completed'] as const) {
      const f = contextHost();
      const s = f.get();
      s.history.unshift(contextRecord('prior-source'));
      s.summary = { scope: contextScope, text: 'valid prior', coveredIds: ['prior-source'], operationId: 'prior' };
      f.set(s);
      f.host.summarize.mockResolvedValue({ status, text: status === 'completed' ? '' : 'partial', coveredIds: ['old-a', 'old-b'] });
      const r = await new ConversationContext(f.host).compact(contextScope, 'fold', contextPolicy);
      if (status === 'completed') expect(r).toMatchObject({ ok: false, code: 'invalid-summary' });
      else expect(r).toMatchObject({ ok: true, value: { outcome: 'summary-failed' } });
      expect(f.get().summary?.coveredIds).toEqual(['prior-source']);
      const selection = selectConversationContext(contextScope, f.get().history, contextPolicy, f.get().summary);
      expect(selection).toMatchObject({ ok: true, value: { omittedIds: ['old-a', 'old-b'] } });
    }
  });

  it('preserves measured and unknown housekeeping usage on summary success and failure', async () => {
    for (const attempt of [
      { status: 'completed', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } },
      { status: 'failed', usage: { inputTokens: 7, costUsd: 0.25 } },
      { status: 'incomplete' },
    ] satisfies SummaryAttempt[]) {
      const f = contextHost();
      f.host.summarize.mockImplementation(async input => ({ ...attempt, text: 'summary', coveredIds: input.records.map(m => m.id) }));
      await new ConversationContext(f.host).compact(contextScope, 'fold', contextPolicy);
      const receipt = f.get().receipts[0];
      expect(receipt.usage).toEqual('usage' in attempt ? attempt.usage : null);
      expect(f.usageJournal.get('fold')).toEqual(receipt);
      if (attempt.status === 'failed') expect(receipt.usage?.outputTokens).toBeUndefined();
    }
  });

  it('does not compact unchanged input or double-count completed coverage', async () => {
    const f = contextHost();
    const manager = new ConversationContext(f.host);
    expect((await manager.compact(contextScope, 'fold', contextPolicy)).ok).toBe(true);
    expect(await manager.compact(contextScope, 'another-id', contextPolicy)).toMatchObject({ ok: true, value: { outcome: 'unchanged' } });
    expect(f.host.summarize).toHaveBeenCalledTimes(1);
    expect(f.usageJournal.size).toBe(1);
    expect(f.get().receipts).toHaveLength(1);
    const small = contextHost([contextRecord('latest', 'question', 'user')]);
    expect(await new ConversationContext(small.host).compact(contextScope, 'noop', contextPolicy))
      .toMatchObject({ ok: true, value: { outcome: 'unchanged' } });
    expect(small.host.summarize).not.toHaveBeenCalled();
    expect(small.host.compareAndSwap).not.toHaveBeenCalled();
  });
});
