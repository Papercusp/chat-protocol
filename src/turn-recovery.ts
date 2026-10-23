import {
  chatEventChannel, parseChatEnvelope, parseChatState, parseRecoveryCapabilities,
  type ChatEventEnvelope, type ChatRecoveryCapabilities, type ChatStateV1,
} from './protocol-v1.js';

export interface TurnIdentity { conversationId: string; turnId: string }
export type RecoveryAction = 'start' | 'dispatch' | 'recover' | 'replay' | 'cancel';
export type EffectCheckpoint = { status: 'pending' }
  | { status: 'dispatching'; claimRevision: number; admitted: boolean }
  | { status: 'completed'; result: unknown };
export type DispatchAdmission<T> = { admitted: false; reason: 'cancelled' | 'conflict' | 'unauthorized' }
  | { admitted: true; result: Promise<T> };
/** Stored alongside existing host session state. Version and CAS come from ChatStateV1. */
export interface TurnCheckpoint {
  state: ChatStateV1;
  effects: Record<string, EffectCheckpoint>;
}
export interface TurnCheckpointStore {
  read(identity: TurnIdentity): Promise<TurnCheckpoint | null>;
  /** Atomic, identity-scoped CAS. Null creates; revisions advance exactly once. */
  compareAndSwap(identity: TurnIdentity, revision: number | null, next: TurnCheckpoint): Promise<boolean>;
  /** Under the SAME fence/transaction as cancellation CAS: revalidate current
   * host authority, running phase, effect claim and !admitted; durably mark
   * admitted and invoke launch ONCE before releasing the fence. Never await the
   * returned effect promise under the fence. An uncertain admission must never
   * be retried. Existing host session/owned-loop storage supplies this seam. */
  admitDispatch<T>(identity: TurnIdentity, effectId: string, claimRevision: number,
    launch: () => Promise<T>): Promise<DispatchAdmission<T>>;
}
export interface ReplayWindow {
  /** Host SSE/persistence watermark, including an empty retained window. */
  lastSequence: number;
  firstAvailableSequence: number;
  events: readonly unknown[];
}
export interface TurnRecoveryAdapter {
  capabilities: ChatRecoveryCapabilities;
  store: TurnCheckpointStore;
  /** Resolve the current caller at each operation; never derive authority from replay/model data. */
  authorize(action: RecoveryAction, identity: TurnIdentity, effectId?: string): Promise<boolean>;
  /** Read the host's existing SSE channel or persistent event stream; no second replay buffer. */
  replay(identity: TurnIdentity, after: number): Promise<ReplayWindow>;
  /** Abort the host-owned execution after cancellation has committed. */
  abortExecution(identity: TurnIdentity): Promise<void>;
}
export type RecoveryFailureCode = 'invalid-state' | 'unauthorized' | 'storage-unavailable'
  | 'checkpoint-write-failed' | 'conflict' | 'cancelled' | 'cancellation-failed'
  | 'needs-reconciliation' | 'restart-recovery-unsupported' | 'replay-unsupported'
  | 'invalid-cursor' | 'replay-expired' | 'dispatch-admission-unsupported';
export type RecoveryResult<T> = { ok: true; value: T } | { ok: false; code: RecoveryFailureCode };
export interface RecoveredEffect extends TurnIdentity {
  effectId: string;
  result: unknown;
  source: 'dispatch' | 'checkpoint';
}
const fail = (code: RecoveryFailureCode): RecoveryResult<never> => ({ ok: false, code });
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512
  && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
const same = (a: TurnIdentity, b: TurnIdentity): boolean =>
  a.conversationId === b.conversationId && a.turnId === b.turnId;
const counter = (v: number): boolean => Number.isSafeInteger(v) && v >= 0;

/** Pure coordination over injected host seams. A model retry is never an effect retry. */
export class TurnRecovery {
  constructor(private readonly adapter: TurnRecoveryAdapter) {}

  private async allowed(action: RecoveryAction, identity: TurnIdentity, effectId?: string): Promise<boolean> {
    if (!id(identity.conversationId) || !id(identity.turnId) || (effectId !== undefined && !id(effectId))) return false;
    try { return await this.adapter.authorize(action, { ...identity }, effectId); }
    catch { return false; }
  }

  private async read(identity: TurnIdentity): Promise<RecoveryResult<TurnCheckpoint>> {
    let record: TurnCheckpoint | null;
    try { record = await this.adapter.store.read(identity); }
    catch { return fail('storage-unavailable'); }
    if (!record || !record.state || !parseChatState(record.state).ok || !same(record.state, identity)
      || !record.effects || typeof record.effects !== 'object' || Array.isArray(record.effects)
      || Object.entries(record.effects).some(([key, effect]) => !id(key) || !effect
        || !['pending', 'dispatching', 'completed'].includes(effect.status)
        || (effect.status === 'dispatching' && (!counter(effect.claimRevision)
          || effect.claimRevision < 1 || typeof effect.admitted !== 'boolean'))
        || (effect.status === 'completed' && !Object.hasOwn(effect, 'result')))) return fail('invalid-state');
    return { ok: true, value: structuredClone(record) };
  }

  async start(identity: TurnIdentity, effectIds: readonly string[]): Promise<RecoveryResult<TurnCheckpoint>> {
    if (!await this.allowed('start', identity)) return fail('unauthorized');
    const capabilities = parseRecoveryCapabilities(this.adapter.capabilities);
    if (!capabilities || !effectIds.length || effectIds.some(key => !id(key))
      || new Set(effectIds).size !== effectIds.length) return fail('invalid-state');
    const next: TurnCheckpoint = {
      state: { schemaVersion: 1, ...identity, revision: 0, phase: 'running', lastSequence: 0, capabilities },
      effects: Object.fromEntries(effectIds.map(key => [key, { status: 'pending' as const }])),
    };
    try {
      if (await this.adapter.store.compareAndSwap(identity, null, next)) return { ok: true, value: next };
    } catch { /* Creation may have committed. Read before reporting an uncertain write. */ }
    const old = await this.read(identity);
    if (!old.ok) return fail(old.code === 'invalid-state' ? 'checkpoint-write-failed' : old.code);
    return Object.keys(old.value.effects).length === effectIds.length
      && effectIds.every(key => Object.hasOwn(old.value.effects, key)) ? old : fail('conflict');
  }

  private completed(identity: TurnIdentity, effectId: string, effect: EffectCheckpoint,
    source: RecoveredEffect['source']): RecoveryResult<RecoveredEffect> {
    return effect.status === 'completed'
      ? { ok: true, value: { ...identity, effectId, result: effect.result, source } }
      : fail('needs-reconciliation');
  }

  /** Restart recovery reads known results only. Pending/unknown effects need host reconciliation. */
  async recover(identity: TurnIdentity, effectId: string): Promise<RecoveryResult<RecoveredEffect>> {
    if (!await this.allowed('recover', identity, effectId)) return fail('unauthorized');
    if (!this.adapter.capabilities.interruptedTurnRecovery || !this.adapter.capabilities.completedToolCheckpoints) {
      return fail('restart-recovery-unsupported');
    }
    const record = await this.read(identity);
    if (!record.ok) return record;
    if (!record.value.state.capabilities.interruptedTurnRecovery
      || !record.value.state.capabilities.completedToolCheckpoints) return fail('restart-recovery-unsupported');
    const effect = Object.hasOwn(record.value.effects, effectId) ? record.value.effects[effectId] : undefined;
    if (!effect) return fail('unauthorized');
    return this.completed(identity, effectId, effect, 'checkpoint');
  }

  async runEffect(identity: TurnIdentity, effectId: string,
    dispatch: (input: TurnIdentity & { effectId: string; signal: AbortSignal }) => Promise<unknown>,
    signal: AbortSignal): Promise<RecoveryResult<RecoveredEffect>> {
    if (!await this.allowed('dispatch', identity, effectId)) return fail('unauthorized');
    const loaded = await this.read(identity);
    if (!loaded.ok) return loaded;
    const record = loaded.value;
    const effect = Object.hasOwn(record.effects, effectId) ? record.effects[effectId] : undefined;
    if (!effect) return fail('unauthorized');
    if (effect.status === 'completed') return this.completed(identity, effectId, effect, 'checkpoint');
    if (record.state.phase === 'cancelled' || signal.aborted) return fail('cancelled');
    if (record.state.phase !== 'running' || effect.status !== 'pending') return fail('needs-reconciliation');
    if (typeof this.adapter.store.admitDispatch !== 'function') return fail('dispatch-admission-unsupported');
    let candidate = record;
    let ownsClaim = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const claimed = structuredClone(candidate);
      claimed.state.revision++;
      claimed.effects[effectId] = { status: 'dispatching', claimRevision: claimed.state.revision, admitted: false };
      try {
        ownsClaim = await this.adapter.store.compareAndSwap(identity, candidate.state.revision, claimed);
      } catch { return fail('needs-reconciliation'); }
      if (ownsClaim) break;
      const latest = await this.read(identity);
      if (!latest.ok) return latest;
      if (latest.value.state.phase === 'cancelled' || signal.aborted) return fail('cancelled');
      // Retry only the CHECKPOINT claim when another effect advanced the turn's
      // revision. This is before any dispatch and cannot retry an external effect.
      if (latest.value.state.phase !== 'running' || latest.value.effects[effectId]?.status !== 'pending') {
        return fail('conflict');
      }
      candidate = latest.value;
    }
    if (!ownsClaim) return fail('conflict');
    // Authorization can await remote state. Revalidate cancellation AFTER that
    // boundary: the host may have committed cancellation while its abort hook
    // is still pending, so signal.aborted alone is insufficient.
    if (!await this.allowed('dispatch', identity, effectId)) return fail('unauthorized');
    const current = await this.read(identity);
    if (!current.ok) return current;
    if (current.value.state.phase === 'cancelled' || signal.aborted) return fail('cancelled');
    const currentEffect = current.value.effects[effectId];
    if (currentEffect?.status === 'completed') return this.completed(identity, effectId, currentEffect, 'checkpoint');
    // Another effect on this turn may legitimately advance the shared revision.
    // This effect's successful pending→dispatching CAS remains its exclusive claim.
    if (current.value.state.phase !== 'running' || currentEffect?.status !== 'dispatching') {
      return fail('needs-reconciliation');
    }
    if (signal.aborted) return fail('cancelled');
    // A read can return a snapshot taken before a concurrent cancellation. The
    // host's atomic admission, NOT this snapshot or delayed abort propagation,
    // decides which side won. Per-effect identity allows unrelated effects to
    // advance the turn revision without invalidating this exclusive claim.
    let admission: DispatchAdmission<unknown>;
    let started = false;
    try {
      admission = await this.adapter.store.admitDispatch(identity, effectId, currentEffect.claimRevision, () => {
        if (signal.aborted) return Promise.reject(new Error('cancelled-before-launch'));
        started = true;
        return dispatch({ ...identity, effectId, signal });
      });
    } catch { return fail('needs-reconciliation'); }
    if (!admission.admitted) return fail(admission.reason);
    let result: unknown;
    try { result = await admission.result; }
    catch { return fail(!started && signal.aborted ? 'cancelled' : 'needs-reconciliation'); }
    // Cancellation may change the revision while an effect is in flight. Preserve its result
    // without reopening the cancelled turn. A failed/uncertain checkpoint never permits dispatch.
    for (let attempt = 0; attempt < 2; attempt++) {
      const latest = await this.read(identity);
      if (!latest.ok) return fail('checkpoint-write-failed');
      const previous = latest.value.effects[effectId];
      if (previous?.status === 'completed') return this.completed(identity, effectId, previous, 'checkpoint');
      if (previous?.status !== 'dispatching') return fail('needs-reconciliation');
      const next = structuredClone(latest.value);
      next.state.revision++;
      next.effects[effectId] = { status: 'completed', result };
      if (next.state.phase !== 'cancelled' && Object.values(next.effects).every(e => e.status === 'completed')) {
        next.state.phase = 'completed';
      }
      try {
        if (!await this.adapter.store.compareAndSwap(identity, latest.value.state.revision, next)) continue;
      } catch {
        const readback = await this.read(identity);
        const committed = readback.ok ? readback.value.effects[effectId] : undefined;
        if (committed?.status !== 'completed') return fail('checkpoint-write-failed');
        if (readback.ok && (readback.value.state.phase === 'cancelled' || signal.aborted)) return fail('cancelled');
        return this.completed(identity, effectId, committed, 'checkpoint');
      }
      if (next.state.phase === 'cancelled' || signal.aborted) return fail('cancelled');
      return this.completed(identity, effectId, next.effects[effectId], 'dispatch');
    }
    return fail('checkpoint-write-failed');
  }

  async cancel(identity: TurnIdentity): Promise<RecoveryResult<TurnCheckpoint>> {
    if (!await this.allowed('cancel', identity)) return fail('unauthorized');
    const loaded = await this.read(identity);
    if (!loaded.ok) return loaded;
    const next = loaded.value;
    if (next.state.phase !== 'cancelled') {
      if (['completed', 'failed'].includes(next.state.phase)) return fail('conflict');
      const revision = next.state.revision++;
      next.state.phase = 'cancelled';
      try {
        if (!await this.adapter.store.compareAndSwap(identity, revision, next)) return fail('conflict');
      } catch {
        const readback = await this.read(identity);
        if (!readback.ok || readback.value.state.phase !== 'cancelled') return fail('checkpoint-write-failed');
      }
    }
    try { await this.adapter.abortExecution({ ...identity }); }
    catch { return fail('cancellation-failed'); }
    return { ok: true, value: next };
  }

  async replay(identity: TurnIdentity, after: number): Promise<RecoveryResult<ChatEventEnvelope[]>> {
    if (!await this.allowed('replay', identity)) return fail('unauthorized');
    if (!this.adapter.capabilities.connectionReplay) return fail('replay-unsupported');
    if (!counter(after)) return fail('invalid-cursor');
    let window: ReplayWindow;
    try { window = await this.adapter.replay(identity, after); }
    catch { return fail('storage-unavailable'); }
    if (!counter(window.lastSequence) || !counter(window.firstAvailableSequence)
      || window.firstAvailableSequence < 1 || window.firstAvailableSequence > window.lastSequence + 1
      || after > window.lastSequence || !Array.isArray(window.events)) return fail('invalid-cursor');
    if (after < window.firstAvailableSequence - 1) return fail('replay-expired');
    const events: ChatEventEnvelope[] = [];
    const eventIds = new Set<string>();
    for (const input of window.events) {
      const parsed = parseChatEnvelope(input);
      if (!parsed.ok || !same(parsed.value, identity) || parsed.value.sequence !== after + events.length + 1
        || parsed.value.sequence > window.lastSequence || eventIds.has(parsed.value.eventId)
        || chatEventChannel(parsed.value.event.type) !== 'event') return fail('invalid-cursor');
      eventIds.add(parsed.value.eventId);
      events.push(parsed.value);
    }
    return after + events.length === window.lastSequence ? { ok: true, value: events } : fail('invalid-cursor');
  }
}
