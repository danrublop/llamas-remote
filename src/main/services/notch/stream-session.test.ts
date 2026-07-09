import { describe, it, expect, vi } from 'vitest';
import { StreamSession } from './stream-session';

function setup() {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  let n = 0;
  const session = new StreamSession({
    send: (channel, payload) => sent.push({ channel, payload }),
    newId: () => `run-${++n}`,
  });
  return { session, sent };
}

describe('StreamSession — readiness queue', () => {
  it('buffers events until the renderer is ready, then flushes in order', () => {
    const { session, sent } = setup();
    const { runId } = session.beginRun();
    session.emit(runId, 'notebook:start', { prompt: 'Ask' });
    session.emit(runId, 'notebook:token', 'he');
    session.emit(runId, 'notebook:token', 'llo');
    expect(sent).toHaveLength(0); // nothing delivered yet

    session.markReady();
    expect(sent).toEqual([
      { channel: 'notebook:start', payload: { prompt: 'Ask' } },
      { channel: 'notebook:token', payload: 'he' },
      { channel: 'notebook:token', payload: 'llo' },
    ]);
  });

  it('sends immediately once ready', () => {
    const { session, sent } = setup();
    const { runId } = session.beginRun();
    session.markReady();
    session.emit(runId, 'notebook:token', 'x');
    expect(sent).toEqual([{ channel: 'notebook:token', payload: 'x' }]);
  });

  it('re-buffers after markNotReady (renderer reload)', () => {
    const { session, sent } = setup();
    const { runId } = session.beginRun();
    session.markReady();
    session.markNotReady();
    session.emit(runId, 'notebook:token', 'buffered');
    expect(sent).toHaveLength(0);
    session.markReady();
    expect(sent).toEqual([{ channel: 'notebook:token', payload: 'buffered' }]);
  });

  it('still flushes a completed run’s trailing events on a later ready', () => {
    const { session, sent } = setup();
    const { runId } = session.beginRun();
    session.emit(runId, 'notebook:done', 'answer');
    session.endRun(runId); // run finished before the renderer mounted
    session.markReady();
    expect(sent).toEqual([{ channel: 'notebook:done', payload: 'answer' }]);
  });

  it('drops a stray late token emitted AFTER the run ended (ghost-token guard)', () => {
    const { session, sent } = setup();
    const { runId } = session.beginRun();
    session.markReady();
    session.emit(runId, 'notebook:token', 'real');
    session.endRun(runId); // run done
    // A not-yet-GC'd provider stream fires one more token after completion — must be dropped.
    session.emit(runId, 'notebook:token', 'ghost');
    expect(sent).toEqual([{ channel: 'notebook:token', payload: 'real' }]);
  });
});

describe('StreamSession — supersede', () => {
  it('drops a superseded run’s future events and only delivers the current run', () => {
    const { session, sent } = setup();
    const a = session.beginRun();
    session.markReady();
    const b = session.beginRun(); // B supersedes A
    session.emit(a.runId, 'notebook:token', 'stale-A');
    session.emit(b.runId, 'notebook:token', 'live-B');
    expect(sent).toEqual([{ channel: 'notebook:token', payload: 'live-B' }]);
  });

  it('drops a superseded run’s still-buffered events on flush', () => {
    const { session, sent } = setup();
    const a = session.beginRun();
    session.emit(a.runId, 'notebook:start', { prompt: 'A' }); // buffered (not ready)
    const b = session.beginRun(); // supersede before ready
    session.emit(b.runId, 'notebook:start', { prompt: 'B' });
    session.markReady();
    expect(sent).toEqual([{ channel: 'notebook:start', payload: { prompt: 'B' } }]);
  });
});

describe('StreamSession — abort', () => {
  it('aborts the previous run’s signal when a new run begins', () => {
    const { session } = setup();
    const a = session.beginRun();
    const onAbort = vi.fn();
    a.signal.addEventListener('abort', onAbort);
    expect(a.signal.aborted).toBe(false);
    session.beginRun();
    expect(a.signal.aborted).toBe(true);
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it('abortActive aborts the current signal and drops its subsequent events', () => {
    const { session, sent } = setup();
    const a = session.beginRun();
    session.markReady();
    session.abortActive(); // e.g. notebook window closed
    expect(a.signal.aborted).toBe(true);
    session.emit(a.runId, 'notebook:token', 'after-abort');
    expect(sent).toHaveLength(0);
  });

  it('a fresh run after abort is not itself aborted', () => {
    const { session } = setup();
    session.beginRun();
    session.abortActive();
    const b = session.beginRun();
    expect(b.signal.aborted).toBe(false);
  });
});
