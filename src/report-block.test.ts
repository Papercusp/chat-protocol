import { describe, expect, it } from 'vitest';
import { parseReportBlock, type ReportBlock } from './index';

describe('parseReportBlock', () => {
  it('parses a full block: title, plans, items, statuses', () => {
    const block = parseReportBlock({
      title: 'Fleet status',
      plans: [
        {
          slug: 'rate-limit-layer-v2',
          title: 'Rate-limit layer v2',
          status: 'active',
          summary: 'top half of the layer',
          items: [
            { id: 'P-001', text: 'Provider-aware error classifier', status: 'done' },
            { id: 'P-003', text: 'Per-call pacing', status: 'wip' },
          ],
        },
      ],
    });
    expect(block).toEqual<ReportBlock>({
      title: 'Fleet status',
      plans: [
        {
          slug: 'rate-limit-layer-v2',
          title: 'Rate-limit layer v2',
          status: 'active',
          summary: 'top half of the layer',
          items: [
            { id: 'P-001', text: 'Provider-aware error classifier', status: 'done' },
            { id: 'P-003', text: 'Per-call pacing', status: 'wip' },
          ],
        },
      ],
    });
  });

  it('applies title→slug and text→id fallbacks', () => {
    const block = parseReportBlock({
      plans: [{ slug: 'only-slug', items: [{ id: 'P-9' }] }],
    });
    expect(block?.plans[0]?.title).toBe('only-slug');
    expect(block?.plans[0]?.items?.[0]?.text).toBe('P-9');
  });

  it('drops plan blocks with neither title nor slug, items with neither text nor id', () => {
    const block = parseReportBlock({
      plans: [
        { status: 'active' }, // dropped — no label
        { title: 'Kept', items: [{ status: 'wip' }, { text: 'real item' }] },
      ],
    });
    expect(block?.plans).toHaveLength(1);
    expect(block?.plans[0]?.items).toEqual([{ id: undefined, text: 'real item', status: undefined }]);
  });

  it('trims whitespace and drops blank strings', () => {
    const block = parseReportBlock({
      title: '   ',
      plans: [{ title: '  Padded  ', status: '', items: [{ text: '  x  ' }] }],
    });
    expect(block?.title).toBeUndefined();
    expect(block?.plans[0]?.title).toBe('Padded');
    expect(block?.plans[0]?.status).toBeUndefined();
    expect(block?.plans[0]?.items?.[0]?.text).toBe('x');
  });

  it('omits items when none survive', () => {
    const block = parseReportBlock({ plans: [{ title: 'Header only', items: [] }] });
    expect(block?.plans[0]?.items).toBeUndefined();
  });

  it('returns null for non-objects, arrays, missing/empty plans', () => {
    expect(parseReportBlock(null)).toBeNull();
    expect(parseReportBlock('nope')).toBeNull();
    expect(parseReportBlock(42)).toBeNull();
    expect(parseReportBlock([])).toBeNull();
    expect(parseReportBlock({})).toBeNull();
    expect(parseReportBlock({ plans: 'x' })).toBeNull();
    expect(parseReportBlock({ plans: [] })).toBeNull();
    expect(parseReportBlock({ plans: [{ status: 'no-label' }] })).toBeNull();
  });

  it('drops items whose numeric id/text cannot coerce to a string, keeps the plan', () => {
    // reportStr returns undefined for non-strings, so a numeric id+text item has
    // no usable text and is dropped — but the plan itself survives (its title is
    // a real string).
    const block = parseReportBlock({ plans: [{ title: 'p', items: [{ id: 5, text: 7 }] }] });
    expect(block).not.toBeNull();
    expect(block?.plans).toHaveLength(1);
    expect(block?.plans[0]?.title).toBe('p');
    expect(block?.plans[0]?.items).toBeUndefined(); // item dropped, none survive
  });

  it('keeps a numeric-text item only when a string id supplies the text fallback', () => {
    const block = parseReportBlock({ plans: [{ title: 'p', items: [{ id: 'P-1', text: 7 }] }] });
    expect(block?.plans[0]?.items).toEqual([{ id: 'P-1', text: 'P-1', status: undefined }]);
  });

  it('ignores a numeric plan status (coerces to undefined), keeps the plan', () => {
    const block = parseReportBlock({ plans: [{ title: 'p', status: 200 }] });
    expect(block?.plans).toHaveLength(1);
    expect(block?.plans[0]?.status).toBeUndefined();
  });

  it('ignores a numeric item status (coerces to undefined)', () => {
    const block = parseReportBlock({ plans: [{ title: 'p', items: [{ text: 'real', status: 1 }] }] });
    expect(block?.plans[0]?.items).toEqual([{ id: undefined, text: 'real', status: undefined }]);
  });

  it('ignores a numeric top-level / plan title that cannot coerce', () => {
    // numeric top title → undefined; numeric plan title alone → plan dropped.
    expect(parseReportBlock({ title: 42, plans: [{ slug: 's', title: 99 }] })?.title).toBeUndefined();
    expect(parseReportBlock({ plans: [{ title: 99 }] })).toBeNull();
  });

  it('parses an actionable item ref, trimmed; drops a blank/non-string ref', () => {
    const block = parseReportBlock({
      plans: [
        {
          title: 'Fleet update',
          items: [
            { text: 'blocked', status: 'blocked', ref: '  escalation:abc123  ' },
            { text: 'no ref' },
            { text: 'blank ref', ref: '   ' },
            { text: 'numeric ref', ref: 42 },
          ],
        },
      ],
    });
    expect(block?.plans[0]?.items).toEqual([
      { id: undefined, text: 'blocked', status: 'blocked', ref: 'escalation:abc123' },
      { id: undefined, text: 'no ref', status: undefined, ref: undefined },
      { id: undefined, text: 'blank ref', status: undefined, ref: undefined },
      { id: undefined, text: 'numeric ref', status: undefined, ref: undefined },
    ]);
  });

  it('never throws on hostile shapes', () => {
    expect(() => parseReportBlock({ plans: [null, 1, 'x', { title: 'ok', items: [null, 7] }] })).not.toThrow();
    const block = parseReportBlock({ plans: [null, 1, 'x', { title: 'ok', items: [null, 7] }] });
    expect(block?.plans).toEqual([
      { slug: undefined, title: 'ok', status: undefined, summary: undefined, items: undefined },
    ]);
  });
});
