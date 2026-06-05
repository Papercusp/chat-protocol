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

  it('never throws on hostile shapes', () => {
    expect(() => parseReportBlock({ plans: [null, 1, 'x', { title: 'ok', items: [null, 7] }] })).not.toThrow();
    const block = parseReportBlock({ plans: [null, 1, 'x', { title: 'ok', items: [null, 7] }] });
    expect(block?.plans).toEqual([
      { slug: undefined, title: 'ok', status: undefined, summary: undefined, items: undefined },
    ]);
  });
});
