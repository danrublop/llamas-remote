import { describe, it, expect } from 'vitest';
import { sanitizeIncomingDrawings } from './drawing-sidecar';

describe('sanitizeIncomingDrawings', () => {
  it('keeps well-formed drawings and passes a valid PNG data-URL through', () => {
    const png = 'data:image/png;base64,AAAA';
    const out = sanitizeIncomingDrawings([{ drawingId: 'abc', scene: { elements: [] }, png }]);
    expect(out).toEqual([{ drawingId: 'abc', scene: { elements: [] }, png }]);
  });

  it('drops entries with a bad id, a non-object scene, or a non-array input', () => {
    expect(sanitizeIncomingDrawings('nope' as unknown)).toEqual([]);
    expect(sanitizeIncomingDrawings([{ drawingId: 'has spaces', scene: {} }])).toEqual([]);
    expect(sanitizeIncomingDrawings([{ drawingId: 'ok', scene: 'notobj' }])).toEqual([]);
  });

  it('dedups a repeated id (copy/paste of a drawing) — keeps the first', () => {
    const out = sanitizeIncomingDrawings([
      { drawingId: 'dup', scene: { v: 1 } },
      { drawingId: 'dup', scene: { v: 2 } },
    ]);
    expect(out).toHaveLength(1);
    expect((out[0].scene as { v: number }).v).toBe(1);
  });

  it('strips a non-PNG or oversized png (scene still kept)', () => {
    const out = sanitizeIncomingDrawings([{ drawingId: 'x', scene: {}, png: 'data:image/jpeg;base64,ZZZ' }]);
    expect(out[0].png).toBeUndefined();
  });
});
