import { parseChatEventV1, type ChatEventV1 } from './protocol-v1.js';

export interface ContextScope { conversationId: string; ownerId: string }
export interface ContextRecord {
  id: string;
  scope: ContextScope;
  role: 'system' | 'user' | 'assistant' | 'tool';
  text: string;
  provenance: { source: string; ref: string };
  callIds?: string[];
  resultIds?: string[];
  mandatory?: boolean;
}
export interface ContextSummary {
  scope: ContextScope;
  text: string;
  coveredIds: string[];
  operationId: string;
}
export interface ContextPolicy {
  budgetTokens: number;
  maxMessageChars?: number;
  /** Host estimator, not provider-reported usage. Defaults to the existing 4-char heuristic. */
  estimate?: (serialized: string) => number;
}
export interface ContextViewRecord extends ContextRecord {
  payload: { originalChars: number; retainedChars: number };
}
export interface ContextSelection {
  messages: ContextViewRecord[];
  summary: ContextSummary | null;
  omittedIds: string[];
  summaryCoveredIds: string[];
  estimatedTokens: number;
}
export type ContextCode = 'invalid-budget' | 'invalid-context' | 'invalid-summary'
  | 'budget-exceeded' | 'unauthorized' | 'storage-unavailable' | 'conflict'
  | 'needs-reconciliation' | 'restart-recovery-unsupported' | 'usage-capture-failed';
export type ContextResult<T> = { ok: true; value: T }
  | { ok: false; code: ContextCode; receipts?: HousekeepingReceipt[] };
type Usage = NonNullable<Extract<ChatEventV1, { type: 'done' }>['usage']>;
export interface SummaryAttempt {
  status: 'completed' | 'failed' | 'incomplete';
  text?: string;
  coveredIds?: string[];
  usage?: Usage;
}
export interface HousekeepingReceipt {
  operationId: string;
  status: SummaryAttempt['status'];
  /** Null and absent fields mean unknown; measured zero remains zero. */
  usage: Usage | null;
}
export interface ContextOperation {
  id: string;
  phase: 'pending' | 'completed';
  sourceVersion: string;
  policyKey: string;
  inputIds: string[];
  failure?: ContextCode;
}
/** Embedded in the host's existing conversation checkpoint. No independent datastore. */
export interface ContextCheckpoint {
  schemaVersion: 1;
  scope: ContextScope;
  revision: number;
  /** Host-owned version of history; appending/changing history must advance it. */
  sourceVersion: string;
  history: ContextRecord[];
  summary: ContextSummary | null;
  operation: ContextOperation | null;
  receipts: HousekeepingReceipt[];
}
export interface ContextHost {
  profile: 'durable' | 'limited';
  authorize(scope: ContextScope): Promise<boolean>;
  read(scope: ContextScope): Promise<ContextCheckpoint | null>;
  compareAndSwap(scope: ContextScope, revision: number, next: ContextCheckpoint): Promise<boolean>;
  summarize(input: {
    scope: ContextScope; operationId: string; priorSummary: ContextSummary | null;
    records: ContextViewRecord[]; signal?: AbortSignal;
  }): Promise<SummaryAttempt>;
  /** Existing liability/usage journal; MUST be idempotent by scoped operationId.
   * Capture even failed/incomplete attempts before the context CAS. */
  observeUsage(scope: ContextScope, receipt: HousekeepingReceipt): Promise<void>;
  /** Read/reconcile the existing provider journal. Never launch another summary here.
   * Null means the outcome remains unknown, so replay is refused. */
  reconcile?(scope: ContextScope, operationId: string): Promise<SummaryAttempt | null>;
}
export interface ContextOutcome {
  checkpoint: ContextCheckpoint;
  selection: ContextSelection;
  outcome: 'unchanged' | 'compacted' | 'summary-failed' | 'recovered';
}
const fail = (code: ContextCode, receipts?: HousekeepingReceipt[]): ContextResult<never> =>
  ({ ok: false, code, ...(receipts ? { receipts } : {}) });
const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  && v.length <= 512 && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
const sameScope = (a: ContextScope, b: ContextScope) =>
  !!a && !!b && a.conversationId === b.conversationId && a.ownerId === b.ownerId;
const validScope = (s: ContextScope) => !!s && validId(s.conversationId) && validId(s.ownerId);
const uniqueIds = (xs: unknown): xs is string[] => Array.isArray(xs)
  && xs.every(validId) && new Set(xs).size === xs.length;
export const estimateContextTokens = (text: string): number => Math.ceil(text.length / 4);
const policyKey = (p: ContextPolicy) => JSON.stringify([p.budgetTokens, p.maxMessageChars ?? 8000]);

function contextGroups(scope: ContextScope, history: readonly ContextRecord[]): number[] | null {
  if (!validScope(scope) || !Array.isArray(history)) return null;
  const ids = new Set<string>();
  const calls = new Map<string, number>();
  const results = new Set<string>();
  const parents = history.map((_, i) => i);
  const root = (i: number): number => {
    while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; }
    return i;
  };
  for (const [i, m] of history.entries()) {
    if (!m || !validId(m.id) || ids.has(m.id) || !sameScope(m.scope, scope)
      || !['system', 'user', 'assistant', 'tool'].includes(m.role) || typeof m.text !== 'string'
      || !m.provenance || !validId(m.provenance.source) || !validId(m.provenance.ref)
      || (m.mandatory !== undefined && typeof m.mandatory !== 'boolean')
      || !uniqueIds(m.callIds ?? []) || !uniqueIds(m.resultIds ?? [])) return null;
    ids.add(m.id);
    if ((m.callIds?.length && m.role !== 'assistant') || (m.resultIds?.length && m.role !== 'tool')) return null;
    for (const id of m.callIds ?? []) {
      if (calls.has(id)) return null;
      calls.set(id, i);
    }
    for (const id of m.resultIds ?? []) {
      const call = calls.get(id);
      if (call === undefined || results.has(id)) return null;
      results.add(id);
      parents[root(i)] = root(call);
    }
  }
  if (calls.size !== results.size) return null; // Pending calls do not become completed replay.
  return parents.map((_, i) => root(i));
}

/** Newest-first selection, with each connected call/result group indivisible.
 * Structural references and omission metadata are charged to the SAME hard budget. */
export function selectConversationContext(scope: ContextScope, history: readonly ContextRecord[],
  policy: ContextPolicy, summary: ContextSummary | null = null): ContextResult<ContextSelection> {
  const maxChars = policy.maxMessageChars ?? 8000;
  if (!Number.isSafeInteger(policy.budgetTokens) || policy.budgetTokens <= 0
    || !Number.isSafeInteger(maxChars) || maxChars < 0) return fail('invalid-budget');
  const groups = contextGroups(scope, history);
  if (!groups) return fail('invalid-context');
  const covered = new Set(summary?.coveredIds ?? []);
  if (summary && (!sameScope(summary.scope, scope) || !validId(summary.operationId)
    || typeof summary.text !== 'string' || !summary.text.trim() || !uniqueIds(summary.coveredIds)
    || summary.coveredIds.some(id => !history.some(m => m.id === id)))) return fail('invalid-summary');
  const latestUser = history.findLastIndex(m => m.role === 'user');
  const mandatory = new Set<number>();
  const members = new Map<number, number[]>();
  for (const [i, m] of history.entries()) {
    const g = groups[i];
    if (m.mandatory || m.role === 'system' || i === history.length - 1 || i === latestUser) mandatory.add(g);
    const indices = members.get(g) ?? [];
    indices.push(i); members.set(g, indices);
  }
  for (const [g, indices] of members) {
    const count = indices.filter(i => covered.has(history[i].id)).length;
    if (count && (count !== indices.length || mandatory.has(g))) return fail('invalid-summary');
  }
  const views = history.map(m => ({ ...structuredClone(m), text: m.text.slice(0, maxChars),
    payload: { originalChars: m.text.length, retainedChars: Math.min(m.text.length, maxChars) } }));
  const eligible = [...members.keys()].filter(g => !covered.has(history[members.get(g)![0]].id));
  const kept = new Set([...mandatory].filter(g => eligible.includes(g)));
  const selected = () => views.filter((_, i) => kept.has(groups[i]));
  const estimate = policy.estimate ?? estimateContextTokens;
  const cost = () => estimate(JSON.stringify({ messages: selected(), summary }));
  let used: number;
  try {
    used = cost();
    if (!Number.isSafeInteger(used) || used < 0) return fail('invalid-budget');
    if (used > policy.budgetTokens) return fail('budget-exceeded');
    for (const g of eligible.reverse()) {
      if (kept.has(g)) continue;
      kept.add(g);
      const next = cost();
      if (!Number.isSafeInteger(next) || next < 0) return fail('invalid-budget');
      if (next > policy.budgetTokens) kept.delete(g);
      else used = next;
    }
  } catch { return fail('invalid-budget'); }
  return { ok: true, value: { messages: selected(), summary: structuredClone(summary),
    omittedIds: history.filter((m, i) => !covered.has(m.id) && !kept.has(groups[i])).map(m => m.id),
    summaryCoveredIds: [...covered], estimatedTokens: used } };
}

function measuredUsage(value: unknown): Usage | null {
  const parsed = parseChatEventV1({ type: 'done', usage: value });
  return parsed?.type === 'done' && parsed.usage && Object.keys(parsed.usage).length
    ? { ...parsed.usage } : null;
}

/** Coordinates host hooks only. Credentials, tools, provider budgets and storage remain host-owned. */
export class ConversationContext {
  private readonly profile: ContextHost['profile'];
  constructor(private readonly host: ContextHost) { this.profile = host.profile; }

  private async allowed(scope: ContextScope): Promise<boolean> {
    try { return validScope(scope) && await this.host.authorize(structuredClone(scope)); }
    catch { return false; }
  }

  private async read(scope: ContextScope): Promise<ContextResult<ContextCheckpoint>> {
    let s: ContextCheckpoint | null;
    try { s = structuredClone(await this.host.read(structuredClone(scope))); }
    catch { return fail('storage-unavailable'); }
    if (!s || s.schemaVersion !== 1 || !sameScope(s.scope, scope)
      || !Number.isSafeInteger(s.revision) || s.revision < 0 || !validId(s.sourceVersion)
      || !contextGroups(scope, s.history) || !Array.isArray(s.receipts)
      || s.receipts.some(r => !validId(r.operationId) || !['completed', 'failed', 'incomplete'].includes(r.status)
        || (r.usage !== null && measuredUsage(r.usage) === null))
      || new Set(s.receipts.map(r => r.operationId)).size !== s.receipts.length
      || (s.operation && (!validId(s.operation.id) || !['pending', 'completed'].includes(s.operation.phase)
        || !validId(s.operation.sourceVersion) || typeof s.operation.policyKey !== 'string'
        || !uniqueIds(s.operation.inputIds) || s.operation.inputIds.some(id => !s!.history.some(m => m.id === id)))))
      return fail('invalid-context');
    return { ok: true, value: s };
  }

  private result(s: ContextCheckpoint, policy: ContextPolicy, outcome: ContextOutcome['outcome']): ContextResult<ContextOutcome> {
    const selected = selectConversationContext(s.scope, s.history, policy, s.summary);
    return selected.ok ? { ok: true, value: { checkpoint: structuredClone(s), selection: selected.value, outcome } } : selected;
  }

  async compact(scope: ContextScope, operationId: string, policy: ContextPolicy,
    signal?: AbortSignal): Promise<ContextResult<ContextOutcome>> {
    scope = structuredClone(scope); policy = { ...policy };
    if (!await this.allowed(scope)) return fail('unauthorized');
    if (!validId(operationId)) return fail('invalid-context');
    const loaded = await this.read(scope);
    if (!loaded.ok) return loaded;
    const s = loaded.value;
    const selected = selectConversationContext(scope, s.history, policy, s.summary);
    if (!selected.ok) return selected;
    if (s.operation?.phase === 'pending') return fail('needs-reconciliation');
    if (s.operation?.id === operationId && (s.operation.sourceVersion !== s.sourceVersion
      || s.operation.policyKey !== policyKey(policy))) return fail('conflict');
    if (s.operation?.sourceVersion === s.sourceVersion && s.operation.policyKey === policyKey(policy))
      return s.operation.failure ? fail(s.operation.failure, s.receipts) : this.result(s, policy, 'unchanged');
    if (!selected.value.omittedIds.length) return this.result(s, policy, 'unchanged');
    if (signal?.aborted) return fail('needs-reconciliation');
    const claimed = structuredClone(s);
    claimed.revision++;
    claimed.operation = { id: operationId, phase: 'pending', sourceVersion: s.sourceVersion,
      policyKey: policyKey(policy), inputIds: selected.value.omittedIds };
    try {
      if (!await this.host.compareAndSwap(scope, s.revision, structuredClone(claimed))) return fail('conflict');
    } catch { return fail('needs-reconciliation'); }
    // Revalidate host authority after the asynchronous claim boundary.
    if (!await this.allowed(scope) || signal?.aborted) return fail('needs-reconciliation');
    let attempt: SummaryAttempt;
    try {
      const ids = new Set(claimed.operation.inputIds);
      attempt = await this.host.summarize({ scope: structuredClone(scope), operationId,
        priorSummary: structuredClone(s.summary), records: s.history.filter(m => ids.has(m.id)).map(m => ({
          ...structuredClone(m), text: m.text.slice(0, policy.maxMessageChars ?? 8000),
          payload: { originalChars: m.text.length, retainedChars: Math.min(m.text.length, policy.maxMessageChars ?? 8000) },
        })), ...(signal ? { signal } : {}) });
    } catch (e) {
      attempt = { status: 'failed', usage: measuredUsage((e as { usage?: unknown } | null)?.usage) ?? undefined };
    }
    if (signal?.aborted) attempt = { ...attempt, status: 'failed' };
    return this.settle(claimed, attempt, policy, false);
  }

  async recover(scope: ContextScope, policy: ContextPolicy): Promise<ContextResult<ContextOutcome>> {
    scope = structuredClone(scope); policy = { ...policy };
    if (!await this.allowed(scope)) return fail('unauthorized');
    if (this.profile !== 'durable') return fail('restart-recovery-unsupported');
    const loaded = await this.read(scope);
    if (!loaded.ok) return loaded;
    const s = loaded.value;
    if (!s.operation || s.operation.phase === 'completed') return this.result(s, policy, 'recovered');
    if (s.operation.sourceVersion !== s.sourceVersion || s.operation.policyKey !== policyKey(policy)) return fail('conflict');
    let attempt: SummaryAttempt | null;
    try { attempt = await this.host.reconcile?.(scope, s.operation.id) ?? null; }
    catch { return fail('needs-reconciliation'); }
    return attempt ? this.settle(s, attempt, policy, true) : fail('needs-reconciliation');
  }

  private async settle(claimed: ContextCheckpoint, attempt: SummaryAttempt, policy: ContextPolicy,
    recovered: boolean): Promise<ContextResult<ContextOutcome>> {
    const operation = claimed.operation!;
    const receipt: HousekeepingReceipt = { operationId: operation.id,
      status: ['completed', 'failed', 'incomplete'].includes(attempt?.status) ? attempt.status : 'failed',
      usage: measuredUsage(attempt?.usage) };
    // Liability survives summary failure, stale CAS, and unknown provider usage.
    try { await this.host.observeUsage(structuredClone(claimed.scope), structuredClone(receipt)); }
    catch { return fail('usage-capture-failed', [receipt]); }
    if (!await this.allowed(claimed.scope)) return fail('unauthorized', [receipt]);
    const loaded = await this.read(claimed.scope);
    if (!loaded.ok) return { ...loaded, receipts: [receipt] };
    const current = loaded.value;
    if (current.operation?.id !== operation.id || current.sourceVersion !== operation.sourceVersion
      || current.revision !== claimed.revision) return fail('conflict', [receipt]);
    const next = structuredClone(current);
    let invalid = false;
    let compacted = false;
    if (receipt.status === 'completed') {
      const ids = attempt.coveredIds;
      invalid = !uniqueIds(ids) || ids.length !== operation.inputIds.length
        || ids.some(id => !operation.inputIds.includes(id)) || typeof attempt.text !== 'string' || !attempt.text.trim();
      if (!invalid) {
        next.summary = { scope: structuredClone(current.scope), text: attempt.text!, operationId: operation.id,
          coveredIds: current.history.filter(m => new Set([...(current.summary?.coveredIds ?? []), ...ids!]).has(m.id)).map(m => m.id) };
        const bounded = selectConversationContext(next.scope, next.history, policy, next.summary);
        if (!bounded.ok) { invalid = true; next.summary = current.summary; }
        else compacted = true;
      }
    }
    next.revision++;
    next.operation = { ...operation, phase: 'completed', ...(invalid ? { failure: 'invalid-summary' as const } : {}) };
    next.receipts.push(receipt);
    try {
      if (!await this.host.compareAndSwap(next.scope, current.revision, structuredClone(next))) return fail('conflict', [receipt]);
    } catch { return fail('needs-reconciliation', [receipt]); }
    if (invalid) return fail('invalid-summary', [receipt]);
    return this.result(next, policy, recovered ? 'recovered' : compacted ? 'compacted' : 'summary-failed');
  }
}
