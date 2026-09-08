import { describe, expect, it } from 'vitest';
import { projectSayText, SayStreamProjector } from './say-stream';

describe('shared converse display projection', () => {
  const reply = 'Two routes. Want me to list the templates?';
  const wire = `<say>${reply}</say><continue/>`;

  it('never exposes envelope fragments at any split boundary', () => {
    for (let split = 0; split <= wire.length; split += 1) {
      const stream = new SayStreamProjector({ allowPlainText: true });
      const first = stream.push(wire.slice(0, split));
      expect(reply.startsWith(first)).toBe(true);
      expect(first + stream.push(wire.slice(split))).toBe(reply);
      expect(stream.complete).toBe(true);
    }
  });

  it('keeps desktop tagged-only semantics and supports plain portal prose', () => {
    expect(new SayStreamProjector().push('Plain reply')).toBe('');
    const plain = new SayStreamProjector({ allowPlainText: true });
    expect(plain.push('Plain ')).toBe('Plain ');
    expect(plain.push('reply')).toBe('reply');
    expect(projectSayText('Plain reply')).toBe('Plain reply');
  });

  it('projects history, interrupted turns, and control-only output safely', () => {
    expect(projectSayText(wire)).toBe(reply);
    expect(projectSayText('  <SAY>Still working</SA')).toBe('Still working');
    expect(projectSayText('<say>')).toBe('');
    expect(projectSayText('<sa')).toBe('');
    expect(projectSayText('<sleep duration="5"><continue/>')).toBe('');
    expect(projectSayText('<report>{"title":"Status"}</report>')).toBe('');
    expect(projectSayText('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
  });

  it('keeps long text and markdown intact instead of applying voice length limits', () => {
    const body = '**A complete answer**\n\n' + 'details '.repeat(100);
    expect(projectSayText(`<say>${body}</say>`)).toBe(body);
  });
});
