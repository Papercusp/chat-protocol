import { vi } from 'vitest';
import type { ContextCheckpoint, ContextHost, ContextRecord, ContextScope, HousekeepingReceipt,
  SummaryAttempt } from '../conversation-context.js';

export const contextScope: ContextScope = { conversationId: 'conversation', ownerId: 'owner' };
export const contextPolicy = { budgetTokens: 256 };
export const contextRecord = (id: string, text = 'text', role: ContextRecord['role'] = 'assistant',
  extra: Partial<ContextRecord> = {}): ContextRecord => ({
  id, scope: { ...contextScope }, role, text, provenance: { source: 'fixture', ref: `ref:${id}` }, ...extra,
});

/** TREE fixture only. The application must supply its real checkpoint and usage journal. */
export function contextHost(history = [contextRecord('old-a', 'a'.repeat(1400)),
  contextRecord('old-b', 'b'.repeat(1400)), contextRecord('latest', 'question', 'user')]) {
  let checkpoint: ContextCheckpoint = { schemaVersion: 1, scope: { ...contextScope }, revision: 0,
    sourceVersion: 'source-1', history, summary: null, operation: null, receipts: [] };
  const usageJournal = new Map<string, HousekeepingReceipt>();
  const providerJournal = new Map<string, SummaryAttempt>();
  const trace: string[] = [];
  const host = {
    profile: 'durable' as ContextHost['profile'],
    authorize: vi.fn(async (scope: ContextScope) => scope.ownerId === contextScope.ownerId
      && scope.conversationId === contextScope.conversationId),
    read: vi.fn(async () => structuredClone(checkpoint)),
    compareAndSwap: vi.fn(async (scope: ContextScope, revision: number, next: ContextCheckpoint) => {
      trace.push(`cas:${next.operation?.phase}`);
      if (scope.ownerId !== checkpoint.scope.ownerId || scope.conversationId !== checkpoint.scope.conversationId
        || checkpoint.revision !== revision) return false;
      checkpoint = structuredClone(next); return true;
    }),
    summarize: vi.fn(async (input: Parameters<ContextHost['summarize']>[0]): Promise<SummaryAttempt> => {
      trace.push('summarize');
      const result: SummaryAttempt = { status: 'completed', text: `${input.priorSummary?.text ?? ''} summary`.trim(),
        coveredIds: input.records.map(r => r.id), usage: { inputTokens: 17, outputTokens: 3, costUsd: 0.001 } };
      providerJournal.set(input.operationId, structuredClone(result)); return result;
    }),
    observeUsage: vi.fn(async (_scope: ContextScope, receipt: HousekeepingReceipt) => {
      trace.push('usage');
      const old = usageJournal.get(receipt.operationId);
      if (old && JSON.stringify(old) !== JSON.stringify(receipt)) throw new Error('usage receipt conflict');
      usageJournal.set(receipt.operationId, structuredClone(receipt));
    }),
    reconcile: vi.fn(async (_scope: ContextScope, operationId: string) => {
      trace.push('reconcile'); return structuredClone(providerJournal.get(operationId) ?? null);
    }),
  } satisfies ContextHost;
  return { host, usageJournal, providerJournal, trace,
    get: () => structuredClone(checkpoint), set: (next: ContextCheckpoint) => { checkpoint = structuredClone(next); } };
}
