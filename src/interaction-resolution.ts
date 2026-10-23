import type { CardResponse, CardSpec } from './index.js';

export interface InteractionIdentity { conversationId: string; correlationId: string }
/** Backend-authenticated scope, never authority inferred from a rendered card. */
export interface InteractionScope {
  principalId: string; tenantId: string; customerId: string; publicOwnerId: string;
}
export interface InteractionSchema { id: string; revision: number }
export interface InteractionDecision {
  submissionId: string; revision: number; decidedAt: number; response: CardResponse;
}
/** Versioned state embedded in the host's existing card/session persistence. */
export interface InteractionRecord extends InteractionIdentity {
  schemaVersion: 1;
  scope: InteractionScope;
  revision: number;
  schema: InteractionSchema;
  spec: CardSpec;
  expiresAt: number;
  status: 'pending' | 'cancelled' | 'resolved';
  decision?: InteractionDecision;
}
export type InteractionFailure = 'invalid-answer' | 'invalid-state' | 'unauthorized' | 'not-found'
  | 'stale-revision' | 'expired' | 'cancelled' | 'already-decided'
  | 'storage-unavailable' | 'needs-reconciliation';
export type InteractionResult<T> = { ok: true; value: T } | { ok: false; code: InteractionFailure };
export interface InteractionTransaction {
  record: InteractionRecord | null;
  now: number;
  /** Checked against current backend credentials/ACL in this transaction's fence. */
  authorized: boolean;
}
export interface InteractionMutation<T> {
  result: InteractionResult<T>;
  /** Write the decision AND advance the host workflow exactly once in this transaction.
   * This means a persisted workflow transition, never an untracked external call. */
  next?: InteractionRecord;
}
export interface InteractionStore {
  /** Serialize with cancellation, revision/schema/scope changes and authority revocation.
   * Read current state + current authority, invoke the synchronous callback once,
   * then atomically persist next and the workflow transition (if present).
   * A failed acknowledgement may follow a successful commit. Never retry a write
   * blindly. This port extends existing session/card storage, not a second store. */
  transact<T>(identity: InteractionIdentity, caller: InteractionScope,
    decide: (current: InteractionTransaction) => InteractionMutation<T>): Promise<InteractionResult<T>>;
}
export interface InteractionAdapter {
  store: InteractionStore;
  /** Compose tooldef's standardValidate with the server-owned schema registry.
   * The schema key must be immutable at a revision. No validator comes from the answer. */
  validate(schema: InteractionSchema, value: Record<string, unknown>): Promise<
    { ok: true; value: Record<string, unknown> } | { ok: false }>;
}
export interface InteractionAnswer {
  submissionId: string;
  revision: number;
  response: unknown;
}
const fail = (code: InteractionFailure): InteractionResult<never> => ({ ok: false, code });
const id = (v: unknown): v is string => typeof v === 'string' && v.trim() === v && v.length > 0
  && v.length <= 512 && !/[\u0000-\u001f\u007f]/.test(v);
const counter = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const scopeKeys = ['principalId', 'tenantId', 'customerId', 'publicOwnerId'] as const;
const sameScope = (a: InteractionScope, b: InteractionScope) => scopeKeys.every(key => a[key] === b[key]);
const validScope = (v: InteractionScope) => object(v) && scopeKeys.every(key => id(v[key]));
const sameIdentity = (a: InteractionIdentity, b: InteractionIdentity) =>
  a.conversationId === b.conversationId && a.correlationId === b.correlationId;
/** Durable answers are JSON. Compare their values independently of storage key
 * order; unsupported/non-JSON shapes cannot prove an uncertain acknowledgement. */
function sameResponse(a: CardResponse, b: CardResponse): boolean {
  const canonical = (value: unknown): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))) return value;
    if (Array.isArray(value)) return value.map(canonical);
    if (object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    throw new Error('non-json-response');
  };
  try { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
  catch { return false; }
}
function response(input: unknown, correlationId: string): CardResponse | null {
  if (!object(input) || input.correlationId !== correlationId) return null;
  const keys = input.action === 'submit' ? ['action', 'correlationId', 'value'] : ['action', 'correlationId'];
  if (Object.keys(input).some(key => !keys.includes(key))) return null;
  if (input.action === 'submit' && object(input.value)) return structuredClone(input) as unknown as CardResponse;
  if (input.action === 'cancel' || input.action === 'decline') return structuredClone(input) as unknown as CardResponse;
  return null;
}
function validRecord(record: InteractionRecord): boolean {
  return record.schemaVersion === 1 && id(record.conversationId) && id(record.correlationId)
    && validScope(record.scope) && counter(record.revision)
    && object(record.schema) && id(record.schema.id) && counter(record.schema.revision)
    && object(record.spec) && typeof record.spec.prompt === 'string'
    && Number.isFinite(record.expiresAt) && record.expiresAt >= 0
    && ['pending', 'cancelled', 'resolved'].includes(record.status)
    && (record.status === 'resolved' ? !!record.decision && id(record.decision.submissionId)
      && record.decision.revision === record.revision && Number.isFinite(record.decision.decidedAt)
      && !!response(record.decision.response, record.correlationId) : record.decision === undefined);
}

/** Coordinates validation and atomic resolution; owns no datastore or in-memory correlator. */
export class InteractionResolver {
  constructor(private readonly adapter: InteractionAdapter) {}

  private checked(current: InteractionTransaction, identity: InteractionIdentity,
    caller: InteractionScope): InteractionResult<InteractionRecord> {
    if (!current.authorized || !validScope(caller)) return fail('unauthorized');
    const record = current.record;
    if (!record) return fail('not-found');
    if (!validRecord(record) || !Number.isFinite(current.now) || current.now < 0) return fail('invalid-state');
    if (!sameIdentity(record, identity) || !sameScope(record.scope, caller)) return fail('unauthorized');
    return { ok: true, value: structuredClone(record) };
  }

  /** Recover pending or terminal state, including after restart; never advances a workflow. */
  async read(identity: InteractionIdentity, caller: InteractionScope): Promise<InteractionResult<InteractionRecord>> {
    if (!identity || !id(identity.conversationId) || !id(identity.correlationId)) return fail('invalid-answer');
    try {
      return await this.adapter.store.transact(identity, caller, current => ({ result: this.checked(current, identity, caller) }));
    } catch { return fail('storage-unavailable'); }
  }

  async resolve(identity: InteractionIdentity, caller: InteractionScope,
    input: InteractionAnswer): Promise<InteractionResult<InteractionDecision>> {
    // Snapshot caller input before any await, including async schema refinements.
    let answer: InteractionAnswer;
    let bound: InteractionIdentity;
    let principal: InteractionScope;
    try { answer = structuredClone(input); bound = structuredClone(identity); principal = structuredClone(caller); }
    catch { return fail('invalid-answer'); }
    if (!answer || !id(answer.submissionId) || !counter(answer.revision)) return fail('invalid-answer');
    const loaded = await this.read(bound, principal);
    if (!loaded.ok) return loaded;
    const candidate = loaded.value;
    let parsed: CardResponse | null;
    try { parsed = response(answer.response, bound.correlationId); }
    catch { return fail('invalid-answer'); }
    if (!parsed || (parsed.action === 'decline' && !candidate.spec.allowDecline)) return fail('invalid-answer');
    if (parsed.action === 'submit') {
      try {
        const validated = await this.adapter.validate({ ...candidate.schema }, structuredClone(parsed.value));
        if (!validated.ok || !object(validated.value)) return fail('invalid-answer');
        parsed = { ...parsed, value: structuredClone(validated.value) };
      } catch { return fail('invalid-answer'); }
    }
    const accepted = parsed;
    try {
      return await this.adapter.store.transact(bound, principal, current => {
        const checked = this.checked(current, bound, principal);
        if (!checked.ok) return { result: checked };
        const record = checked.value;
        if (record.status === 'resolved') return { result: fail('already-decided') };
        if (record.status === 'cancelled') return { result: fail('cancelled') };
        if (current.now >= record.expiresAt) return { result: fail('expired') };
        if (record.revision !== answer.revision || record.revision !== candidate.revision
          || record.schema.id !== candidate.schema.id || record.schema.revision !== candidate.schema.revision
          || !sameScope(record.scope, candidate.scope)) return { result: fail('stale-revision') };
        if (!counter(record.revision + 1)) return { result: fail('invalid-state') };
        // Pending metadata changes must advance revision, including allowDecline.
        if (accepted.action === 'decline' && !record.spec.allowDecline) return { result: fail('invalid-answer') };
        const decision: InteractionDecision = { submissionId: answer.submissionId,
          revision: record.revision + 1, decidedAt: current.now, response: accepted };
        return { next: { ...record, revision: decision.revision, status: 'resolved', decision },
          result: { ok: true, value: structuredClone(decision) } };
      });
    } catch {
      // One read-only reconciliation. A pending row or another winner is NOT permission to retry.
      const recovered = await this.read(bound, principal);
      if (recovered.ok && recovered.value.status === 'resolved'
        && recovered.value.decision?.submissionId === answer.submissionId
        && recovered.value.decision.revision === answer.revision + 1
        && recovered.value.schema.id === candidate.schema.id
        && recovered.value.schema.revision === candidate.schema.revision
        && sameResponse(recovered.value.decision.response, accepted)) {
        return { ok: true, value: recovered.value.decision };
      }
      return fail('needs-reconciliation');
    }
  }
}
