import { describe, expect, it } from 'vitest';
import { parseAskBlock, parseAskBody, parseAskTag, serializeAskTag, type AskBlock } from './index';

describe('parseAskBlock', () => {
  it('parses a full block: question, options, refs', () => {
    const block = parseAskBlock({
      question: 'Which account should the fleet route through?',
      options: [
        { id: 'default', label: 'Default system account' },
        { id: 'auto', label: 'Gateway auto-routing', description: 'fails over across the pool' },
      ],
      refs: ['WI-5235', 'owner-inbox-single-pane-2026-07-17#P-003'],
    });
    expect(block).toEqual<AskBlock>({
      question: 'Which account should the fleet route through?',
      options: [
        { id: 'default', label: 'Default system account', description: undefined },
        { id: 'auto', label: 'Gateway auto-routing', description: 'fails over across the pool' },
      ],
      refs: ['WI-5235', 'owner-inbox-single-pane-2026-07-17#P-003'],
    });
  });

  it('parses a free-text question with no options/refs', () => {
    const block = parseAskBlock({ question: 'Proceed with the migration now?' });
    expect(block).toEqual<AskBlock>({ question: 'Proceed with the migration now?' });
    expect(block?.options).toBeUndefined();
    expect(block?.refs).toBeUndefined();
  });

  it('applies label→id fallback for an option missing label', () => {
    const block = parseAskBlock({ question: 'q', options: [{ id: 'opt_a' }] });
    expect(block?.options).toEqual([{ id: 'opt_a', label: 'opt_a', description: undefined }]);
  });

  it('drops options with no id, keeps the block', () => {
    const block = parseAskBlock({
      question: 'q',
      options: [{ label: 'no id here' }, { id: 'kept', label: 'Kept' }],
    });
    expect(block?.options).toEqual([{ id: 'kept', label: 'Kept', description: undefined }]);
  });

  it('omits options entirely when none survive', () => {
    const block = parseAskBlock({ question: 'q', options: [{ label: 'no id' }] });
    expect(block?.options).toBeUndefined();
  });

  it('drops non-string / blank refs, keeps valid ones', () => {
    const block = parseAskBlock({ question: 'q', refs: ['WI-1', '', '   ', 42, null, 'WI-2'] });
    expect(block?.refs).toEqual(['WI-1', 'WI-2']);
  });

  it('omits refs entirely when none survive', () => {
    const block = parseAskBlock({ question: 'q', refs: ['', 42, null] });
    expect(block?.refs).toBeUndefined();
  });

  it('trims whitespace and drops a blank question', () => {
    expect(parseAskBlock({ question: '  What now?  ' })?.question).toBe('What now?');
    expect(parseAskBlock({ question: '   ' })).toBeNull();
  });

  it('returns null for non-objects, arrays, missing/blank question', () => {
    expect(parseAskBlock(null)).toBeNull();
    expect(parseAskBlock(undefined)).toBeNull();
    expect(parseAskBlock('nope')).toBeNull();
    expect(parseAskBlock(42)).toBeNull();
    expect(parseAskBlock([])).toBeNull();
    expect(parseAskBlock({})).toBeNull();
    expect(parseAskBlock({ question: 42 })).toBeNull();
    expect(parseAskBlock({ options: [{ id: 'a', label: 'a' }] })).toBeNull();
  });

  it('never throws on hostile shapes', () => {
    expect(() =>
      parseAskBlock({ question: 'q', options: [null, 1, 'x', { id: 5, label: 7 }], refs: 'not-an-array' }),
    ).not.toThrow();
    const block = parseAskBlock({ question: 'q', options: [null, 1, 'x', { id: 5, label: 7 }], refs: 'not-an-array' });
    // numeric id/label never coerce to strings (reportStr rejects non-strings),
    // so the one non-null-ish option candidate is dropped too — block survives
    // on question alone.
    expect(block).toEqual<AskBlock>({ question: 'q' });
  });

  it('ignores a non-array refs value entirely (no throw, refs omitted)', () => {
    expect(parseAskBlock({ question: 'q', refs: { not: 'an array' } })).toEqual<AskBlock>({ question: 'q' });
  });
});

describe('parseAskBody', () => {
  it('JSON-parses then validates', () => {
    expect(parseAskBody('{"question":"ok?"}')).toEqual<AskBlock>({ question: 'ok?' });
  });

  it('returns null on invalid JSON', () => {
    expect(parseAskBody('{not json')).toBeNull();
    expect(parseAskBody('')).toBeNull();
  });

  it('returns null when the parsed JSON is a valid-JSON-but-invalid-shape value', () => {
    expect(parseAskBody('42')).toBeNull();
    expect(parseAskBody('"a bare string"')).toBeNull();
    expect(parseAskBody('null')).toBeNull();
    expect(parseAskBody('{}')).toBeNull();
  });
});

describe('parseAskTag', () => {
  it('extracts a well-formed tag out of surrounding turn prose', () => {
    const raw = 'Before text.\n<ask>{"question":"Ship it?","options":[{"id":"y","label":"Yes"}]}</ask>\nAfter text.';
    expect(parseAskTag(raw)).toEqual<AskBlock>({
      question: 'Ship it?',
      options: [{ id: 'y', label: 'Yes', description: undefined }],
    });
  });

  it('is case-insensitive on the tag name', () => {
    expect(parseAskTag('<ASK>{"question":"q"}</ASK>')).toEqual<AskBlock>({ question: 'q' });
  });

  it('returns null when no tag is present', () => {
    expect(parseAskTag('just some prose, no tag here')).toBeNull();
  });

  it('returns null when the tag body is malformed JSON', () => {
    expect(parseAskTag('<ask>{not valid json</ask>')).toBeNull();
  });

  it('returns null when the tag body is empty', () => {
    expect(parseAskTag('<ask></ask>')).toBeNull();
  });

  it('never throws on a truncated / unclosed tag', () => {
    expect(() => parseAskTag('<ask>{"question":"dangling"')).not.toThrow();
    expect(parseAskTag('<ask>{"question":"dangling"')).toBeNull();
  });

  it('takes the first tag when multiple are present', () => {
    const raw = '<ask>{"question":"first"}</ask> some text <ask>{"question":"second"}</ask>';
    expect(parseAskTag(raw)?.question).toBe('first');
  });
});

describe('serializeAskTag', () => {
  it('round-trips through parseAskTag', () => {
    const block: AskBlock = {
      question: 'Which route?',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', description: 'the safer one' }],
      refs: ['WI-5235'],
    };
    const tag = serializeAskTag(block);
    expect(tag.startsWith('<ask>')).toBe(true);
    expect(tag.endsWith('</ask>')).toBe(true);
    expect(parseAskTag(tag)).toEqual(block);
  });

  it('round-trips a minimal free-text question', () => {
    const block: AskBlock = { question: 'Proceed?' };
    expect(parseAskTag(serializeAskTag(block))).toEqual(block);
  });

  it('produces valid embeddable JSON with quotes / angle brackets in the question', () => {
    const block: AskBlock = { question: 'Use a "quoted" word & a <tag>-looking bit?' };
    const tag = serializeAskTag(block);
    expect(parseAskTag(tag)).toEqual(block);
  });

  it('CAVEAT: a literal closing-tag substring inside the JSON body defeats the', () => {
    // non-greedy tag regex (the same tradeoff REPORT_RE makes) — the parser
    // stops at the first `</ask>` it finds, even one embedded inside the JSON
    // string, producing truncated/invalid JSON. Documented here so a future
    // change to the tag-matching strategy has a regression test to update.
    const block: AskBlock = { question: 'Literally type </ask> in your answer.' };
    const tag = serializeAskTag(block);
    expect(parseAskTag(tag)).toBeNull();
  });
});
