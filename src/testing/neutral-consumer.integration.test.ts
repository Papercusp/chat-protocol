/// <reference types="node" />
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { checkConformance } from './conformance.js';
import { authorizedAnswer, createFixture, FakeStorage, fourEventReplay } from './fakes.js';
import { NeutralConsumer } from './neutral-consumer.js';

describe('neutral protocol consumer integration', () => {
  it('neutral consumer detects duplicate completed effects without importing application business behavior', () => {
    // Bound the whole local runtime import graph using TypeScript syntax, including dynamic imports.
    const visited = new Set<string>();
    const visit = (url: URL) => {
      if (visited.has(url.href)) return;
      visited.add(url.href);
      const source = ts.createSourceFile(url.pathname, readFileSync(url, 'utf8'), ts.ScriptTarget.Latest, true);
      const walk = (node: ts.Node) => {
        const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
          : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
            || ts.isIdentifier(node.expression) && node.expression.text === 'require') ? node.arguments[0] : undefined;
        if (specifier && ts.isStringLiteral(specifier)) {
          expect(specifier.text.startsWith('.')).toBe(true);
          const dependency = new URL(specifier.text.replace(/\.js$/, '.ts'), url);
          expect(dependency.pathname.startsWith(new URL('../', import.meta.url).pathname)).toBe(true);
          visit(dependency);
        }
        ts.forEachChild(node, walk);
      };
      walk(source);
    };
    visit(new URL('./neutral-consumer.ts', import.meta.url));
    expect(visited.has(new URL('../protocol-v1.ts', import.meta.url).href)).toBe(true);
    expect(checkConformance(f => new NeutralConsumer(f))).toEqual([]);
    const f = createFixture();
    const first = new NeutralConsumer(f);
    first.replay(fourEventReplay());
    new NeutralConsumer({ ...f, storage: new FakeStorage(f.clock, f.storage.db) }).replay(fourEventReplay());
    expect(f.storage.db.effects).toHaveLength(1);
    const bad = checkConformance(fixture => {
      const candidate = new NeutralConsumer(fixture);
      return { answer: candidate.answer.bind(candidate), replay: events => {
        candidate.replay(events);
        fixture.storage.db.effects.push({ key: 'uncheckpointed', scope: fixture.scope, result: 'again' });
      } };
    });
    expect(bad.some(v => v.scenario === 'duplicate-completed-effect')).toBe(true);
  });
  it('neutral consumer rejects foreign and malformed answers while preserving one authorized terminal decision', async () => {
    expect(checkConformance(f => new NeutralConsumer(f))).toEqual([]);
    const f = createFixture();
    const workers = [new NeutralConsumer(f), new NeutralConsumer({ ...f, storage: new FakeStorage(f.clock, f.storage.db) })];
    const outcomes = await Promise.allSettled(workers.map(worker => Promise.resolve().then(() => worker.answer(authorizedAnswer(f)))));
    expect(outcomes.map(o => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(f.storage.db.decisions.size).toBe(1); expect(f.storage.db.effects).toHaveLength(1);
    const lost = createFixture(); lost.storage.loseNextAcknowledgement = true;
    expect(() => new NeutralConsumer(lost).answer(authorizedAnswer(lost))).toThrow('effect-unknown');
    const restarted = new NeutralConsumer({ ...lost, storage: new FakeStorage(lost.clock, lost.storage.db) });
    expect(() => restarted.answer(authorizedAnswer(lost))).toThrow('stale-revision');
    expect(lost.storage.db.decisions.get('question-1')).toEqual({ correlationId: 'question-1', revision: 1, value: { selected: 'accept' } });
    expect(lost.storage.db.effects).toHaveLength(1);
  });
});
