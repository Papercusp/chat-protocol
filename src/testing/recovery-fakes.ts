import {
  TurnRecovery, type TurnIdentity, type TurnCheckpoint, type TurnCheckpointStore, type TurnRecoveryAdapter,
} from '../turn-recovery.js';
import { FakeClock, FakeStorage, fourEventReplay } from './fakes.js';
import type { ChatRecoveryCapabilities } from '../protocol-v1.js';

export const recoveryIdentity: TurnIdentity = { conversationId: 'conversation-1', turnId: 'turn-1' };
export const durableCapabilities: ChatRecoveryCapabilities = {
  connectionReplay: true, persistedHistory: true, persistedInteractionDecisions: true,
  completedToolCheckpoints: true, interruptedTurnRecovery: true,
};
export const lightweightCapabilities: ChatRecoveryCapabilities = {
  connectionReplay: true, persistedHistory: false, persistedInteractionDecisions: false,
  completedToolCheckpoints: false, interruptedTurnRecovery: false,
};
const key = (identity: TurnIdentity) => JSON.stringify([identity.conversationId, identity.turnId]);
/** Deterministic CAS fake, explicitly tree evidence rather than production durability. */
export class RecoveryStorage implements TurnCheckpointStore {
  available = true;
  failCompletion = false;
  loseCompletionAcknowledgement = false;
  loseClaimAcknowledgement = false;
  reads = 0;
  constructor(readonly records = new Map<string, TurnCheckpoint>()) {}
  async read(identity: TurnIdentity): Promise<TurnCheckpoint | null> {
    this.reads++;
    if (!this.available) throw new Error('storage-unavailable');
    return structuredClone(this.records.get(key(identity)) ?? null);
  }
  async compareAndSwap(identity: TurnIdentity, revision: number | null, next: TurnCheckpoint): Promise<boolean> {
    if (!this.available || (this.failCompletion && Object.values(next.effects).some(e => e.status === 'completed'))) {
      throw new Error('storage-unavailable');
    }
    const old = this.records.get(key(identity));
    if ((old?.state.revision ?? null) !== revision) return false;
    if (next.state.revision !== (revision === null ? 0 : revision + 1)) throw new Error('bad-revision');
    this.records.set(key(identity), structuredClone(next));
    if (this.loseCompletionAcknowledgement && Object.values(next.effects).some(e => e.status === 'completed')) {
      this.loseCompletionAcknowledgement = false;
      throw new Error('ack-lost');
    }
    if (this.loseClaimAcknowledgement && Object.values(next.effects).some(e => e.status === 'dispatching')) {
      this.loseClaimAcknowledgement = false;
      throw new Error('ack-lost');
    }
    return true;
  }
}
export function recoveryFixture(capabilities = durableCapabilities, store = new RecoveryStorage(),
  events = new FakeStorage(new FakeClock())) {
  const control = new AbortController();
  const fixture = { authorized: true, calls: [] as Array<TurnIdentity & { effectId: string }>, store, events, control };
  const adapter: TurnRecoveryAdapter = {
    capabilities: { ...capabilities }, store,
    async authorize(_action, identity, effectId) {
      return fixture.authorized && key(identity) === key(recoveryIdentity) && (!effectId || effectId === 'read-1');
    },
    async replay(_identity, after) {
      return { lastSequence: events.db.events.at(-1)?.sequence ?? 0,
        firstAvailableSequence: events.db.events[0]?.sequence ?? 1, events: events.replay(after) };
    },
    async abortExecution() { control.abort(); },
  };
  return Object.assign(fixture, {
    adapter, worker: new TurnRecovery(adapter),
    async dispatch(input: TurnIdentity & { effectId: string; signal: AbortSignal }) {
      fixture.calls.push({ conversationId: input.conversationId, turnId: input.turnId, effectId: input.effectId });
      return { ref: 'document:1', text: 'Stored document' };
    },
    seedReplay() { for (const event of fourEventReplay()) events.append(event); },
  });
}
