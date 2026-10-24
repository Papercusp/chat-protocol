import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseChatEventV1, type ChatResultBlock } from '../protocol-v1.js';
import { collectTurnResults, parseStructuredResults, resultActionIntent } from '../structured-results.js';

const result = (kind: ChatResultBlock['kind'] = 'document'): ChatResultBlock => ({
  id: 'result-1', kind, title: 'A document', text: 'A source-backed answer',
  sources: [{ ref: 'document:1', label: 'Original document' }],
  actions: [{ id: 'open', kind: 'open-document', label: 'Open', ref: 'document:1' }],
});
describe('structured result contract', () => {
  it('reconstructs result references from durable turn events with replacement by stable ID and no dispatch', () => {
    const identity = { conversationId: 'conversation-one', turnId: 'turn-one' };
    const envelope = (sequence: number, event: unknown) => ({ schemaVersion: 1, ...identity,
      eventId: `event-${sequence}`, sequence, event });
    const old = result();
    const current = { ...old, title: 'Current authorized title' };
    const events = [envelope(1, { type: 'result', blocks: [old] }),
      envelope(2, { type: 'delta', text: 'answer' }), envelope(3, { type: 'result', blocks: [current] })];
    expect(collectTurnResults(events, identity)).toEqual({ ok: true, value: [current] });
    expect(collectTurnResults([], identity)).toEqual({ ok: true, value: [] });
    for (const invalid of [null, [events[0], events[2]], [events[0], events[0]],
      [{ ...events[0], conversationId: 'foreign' }], [{ ...events[0], turnId: 'foreign' }],
      [{ ...events[0], schemaVersion: 2 }], [envelope(1, { type: 'result', blocks: [old, old] })]]) {
      expect(collectTurnResults(invalid, identity)).toEqual({ ok: false, code: 'invalid' });
    }
  });

  it('preserves stable result identity and provenance across supported result kinds', () => {
    for (const kind of ['entity', 'document', 'report', 'task', 'suggestion'] as const) {
      const original = result(kind);
      expect(parseStructuredResults([original])).toEqual({ ok: true, value: [original] });
      expect(parseChatEventV1({ type: 'result', blocks: [original] })).toEqual({ type: 'result', blocks: [original] });
    }
    const legacyBlock = result();
    delete legacyBlock.actions;
    expect(parseStructuredResults([legacyBlock])).toEqual({ ok: true, value: [legacyBlock] });
  });

  it('rejects malformed duplicate and ungrounded results without actionable output', () => {
    for (const blocks of [null, {}, [null], [result(), result()], [{ ...result(), id: '' }],
      [{ ...result(), kind: 'arbitrary-code' }], [{ ...result(), sources: [] }],
      [{ ...result(), sources: [{ ref: '' }] }], [{ ...result(), actions: [result().actions![0], result().actions![0]] }],
      [{ ...result(), actions: [{ ...result().actions![0], ref: 'document:foreign' }] }]]) {
      expect(parseStructuredResults(blocks)).toEqual({ ok: false, code: 'invalid' });
    }
    expect(resultActionIntent(result(), 'unknown')).toEqual({ ok: false, code: 'unavailable' });
  });

  it('keeps suggested actions as scoped intents without dispatch authority', () => {
    const injected = { ...result(), actions: [{ ...result().actions![0], authorized: true,
      principalId: 'pretend-owner', tool: 'delete-all', href: 'javascript:alert(1)' }] };
    const parsed = parseStructuredResults([injected]);
    expect(parsed).toEqual({ ok: true, value: [result()] });
    expect(resultActionIntent(injected, 'open')).toEqual({ ok: true,
      value: { resultId: 'result-1', actionId: 'open', kind: 'open-document', ref: 'document:1' } });
    expect(resultActionIntent({ ...injected, actions: [{ ...injected.actions[0], ref: 'foreign' }] }, 'open'))
      .toEqual({ ok: false, code: 'invalid' });
  });

  it('neutral result contracts import no application business types', () => {
    for (const path of ['../structured-results.ts', '../protocol-v1.ts']) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      const imports = [...source.matchAll(/(?:from\s+|import\s*\()['"]([^'"\n]+)['"]/g)].map(match => match[1]);
      expect(imports.length).toBeGreaterThan(0);
      expect(imports.every(specifier => specifier.startsWith('./'))).toBe(true);
      expect(source).not.toMatch(/from\s+['"][^'"]*(?:apps\/|scout|catalog|operator-core|shopping)/);
    }
    expect(parseStructuredResults([result('document'), { ...result('entity'), id: 'entity-1' }]).ok).toBe(true);
  });
});
