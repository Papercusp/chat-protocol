import { InteractionResolver, type InteractionAdapter, type InteractionAnswer, type InteractionIdentity,
  type InteractionMutation, type InteractionRecord, type InteractionResult, type InteractionScope,
  type InteractionStore, type InteractionTransaction } from '../interaction-resolution.js';
import { FakeClock, FakeStorage, FIXTURE_BUDGETS, fixtureScope } from './fakes.js';

export const interactionIdentity: InteractionIdentity = { conversationId: 'conversation-1', correlationId: 'question-1' };
export const interactionScope: InteractionScope = { principalId: 'principal-1', ...fixtureScope() };
export const interactionKey = (identity: InteractionIdentity) => JSON.stringify([identity.conversationId, identity.correlationId]);
export const interactionAnswer = (submissionId = 'answer-1'): InteractionAnswer => ({
  submissionId, revision: 0, response: { action: 'submit', correlationId: 'question-1', value: { selected: 'accept' } },
});
export function pendingInteraction(identity = interactionIdentity): InteractionRecord {
  return { schemaVersion: 1, ...identity, scope: { ...interactionScope }, revision: 0,
    schema: { id: 'document-choice', revision: 1 }, expiresAt: FIXTURE_BUDGETS.interactionExpiryMs,
    spec: { prompt: 'Read the document?', presentation: { kind: 'radio', options: [
      { id: 'accept', label: 'Read' }, { id: 'reject', label: 'Cancel' },
    ] } }, status: 'pending' };
}
/** Same deterministic card/session fake database across workers; NOT Postgres evidence. */
export class InteractionStorage implements InteractionStore {
  authorized = true;
  available = true;
  failBeforeCommit = false;
  loseNextAcknowledgement = false;
  constructor(readonly storage: FakeStorage) {}
  async transact<T>(identity: InteractionIdentity, caller: InteractionScope,
    decide: (current: InteractionTransaction) => InteractionMutation<T>,
  ): Promise<InteractionResult<T>> {
    if (!this.available) throw new Error('storage-unavailable');
    const key = interactionKey(identity);
    // No await: authority + snapshot + decision + workflow advance are one fake fence.
    const mutation = decide({ record: structuredClone(this.storage.db.interactions.get(key) ?? null),
      now: this.storage.clock.now, authorized: this.authorized &&
        Object.keys(interactionScope).every(field => caller?.[field as keyof InteractionScope]
          === interactionScope[field as keyof InteractionScope]) });
    if (mutation.next) {
      if (this.failBeforeCommit) throw new Error('write-failed');
      const next = structuredClone(mutation.next);
      this.storage.db.interactions.set(key, next);
      this.storage.db.interactionAdvances.push(structuredClone(next));
      if (this.loseNextAcknowledgement) {
        this.loseNextAcknowledgement = false;
        throw new Error('ack-lost');
      }
    }
    return mutation.result;
  }
}
export function interactionFixture(storage = new FakeStorage(new FakeClock()), seed = true) {
  if (seed) storage.db.interactions.set(interactionKey(interactionIdentity), pendingInteraction());
  const store = new InteractionStorage(storage);
  const adapter: InteractionAdapter = { store,
    async validate(schema, value) {
      // Deterministic server-owned schema port fixture. Production composes standardValidate.
      return schema.id === 'document-choice' && schema.revision === 1
        && Object.keys(value).length === 1 && ['accept', 'reject'].includes(value.selected as string)
        ? { ok: true, value } : { ok: false };
    },
  };
  return { storage, store, adapter, resolver: new InteractionResolver(adapter),
    record: () => storage.db.interactions.get(interactionKey(interactionIdentity))!,
    advances: storage.db.interactionAdvances };
}
