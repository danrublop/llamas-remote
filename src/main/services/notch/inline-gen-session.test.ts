// Tests for InlineGenerationSession — the per-block generation manager. The whole point is
// that inline blocks are INDEPENDENT: one block's generation (or a panel query) must not
// abort another's, and a re-run of a block supersedes only itself and never leaves the block
// stuck. These are the exact hazards the shared-StreamSession design caused.

import { describe, it, expect } from 'vitest';
import { InlineGenerationSession } from './inline-gen-session';

function setup() {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  let n = 0;
  const session = new InlineGenerationSession({
    send: (channel, payload) => sent.push({ channel, payload }),
    newId: () => `run-${++n}`,
  });
  return { session, sent };
}

describe('InlineGenerationSession', () => {
  it('delivers events for an active run', () => {
    const { session, sent } = setup();
    const { runId } = session.begin('block-a');
    session.emit('block-a', runId, 'notebook:gen-token', { blockId: 'block-a', delta: 'hi' });
    expect(sent).toEqual([{ channel: 'notebook:gen-token', payload: { blockId: 'block-a', delta: 'hi' } }]);
  });

  it('runs for different blocks are independent (no mutual abort)', () => {
    const { session, sent } = setup();
    const a = session.begin('block-a');
    const b = session.begin('block-b'); // must NOT abort block-a
    expect(a.signal.aborted).toBe(false);
    expect(b.signal.aborted).toBe(false);
    // both can still stream
    session.emit('block-a', a.runId, 'notebook:gen-token', { blockId: 'block-a', delta: 'A' });
    session.emit('block-b', b.runId, 'notebook:gen-token', { blockId: 'block-b', delta: 'B' });
    expect(sent.map((e) => (e.payload as { delta: string }).delta)).toEqual(['A', 'B']);
  });

  it('a re-run supersedes ONLY the same block, aborting its prior run', () => {
    const { session } = setup();
    const first = session.begin('block-a');
    const second = session.begin('block-a'); // re-run of the same block
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  it('drops events from a superseded run so they cannot touch the re-run block', () => {
    const { session, sent } = setup();
    const first = session.begin('block-a');
    const second = session.begin('block-a');
    // Late token/terminal from the aborted first run must be ignored...
    session.emit('block-a', first.runId, 'notebook:gen-token', { blockId: 'block-a', delta: 'stale' });
    session.emit('block-a', first.runId, 'notebook:gen-error', { blockId: 'block-a', message: 'cancelled' });
    expect(sent).toHaveLength(0);
    // ...while the current run still delivers.
    session.emit('block-a', second.runId, 'notebook:gen-done', { blockId: 'block-a', answer: 'ok', model: 'm' });
    expect(sent).toHaveLength(1);
  });

  it('end() only clears the slot if the run still owns it', () => {
    const { session, sent } = setup();
    const first = session.begin('block-a');
    const second = session.begin('block-a');
    session.end('block-a', first.runId); // superseded run finishing late must NOT free the slot
    session.emit('block-a', second.runId, 'notebook:gen-token', { blockId: 'block-a', delta: 'live' });
    expect(sent).toHaveLength(1); // second run is still active
    session.end('block-a', second.runId);
    session.emit('block-a', second.runId, 'notebook:gen-token', { blockId: 'block-a', delta: 'after-end' });
    expect(sent).toHaveLength(1); // slot cleared — no delivery
  });

  it('abortAll aborts every in-flight run (window closed/reloaded)', () => {
    const { session, sent } = setup();
    const a = session.begin('block-a');
    const b = session.begin('block-b');
    session.abortAll();
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    // no run owns any block anymore, so late emits are dropped
    session.emit('block-a', a.runId, 'notebook:gen-token', { blockId: 'block-a', delta: 'x' });
    expect(sent).toHaveLength(0);
  });
});
