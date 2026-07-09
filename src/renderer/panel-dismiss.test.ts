import { describe, it, expect } from 'vitest';
import {
  decideEscapeAction,
  decideBlurAction,
  reconcilePick,
  draftAfter,
  statusAfterDismiss,
} from './panel-dismiss';

describe('decideEscapeAction (two-stage Esc)', () => {
  it('stage 1: closes the ask input when typing (even if expanded)', () => {
    expect(decideEscapeAction({ typing: true, expanded: true })).toBe('close-input');
    expect(decideEscapeAction({ typing: true, expanded: false })).toBe('close-input');
  });
  it('stage 2: collapses the expanded panel when not typing', () => {
    expect(decideEscapeAction({ typing: false, expanded: true })).toBe('collapse');
  });
  it('noop when collapsed and not typing', () => {
    expect(decideEscapeAction({ typing: false, expanded: false })).toBe('noop');
  });
});

describe('decideBlurAction (capture-guarded window blur)', () => {
  it('collapses on blur when no capture is in flight', () => {
    expect(decideBlurAction({ captureInFlight: false })).toBe('collapse');
  });
  it('does NOT collapse while a native capture is in flight (picker/screenshot/OCR)', () => {
    expect(decideBlurAction({ captureInFlight: true })).toBe('noop');
  });
});

describe('reconcilePick', () => {
  it('keeps a pick that is still installed', () => {
    expect(reconcilePick('llama3', ['llama3', 'mistral'])).toBe('llama3');
  });
  it('drops a pick that is no longer installed (regression: must not survive)', () => {
    expect(reconcilePick('llama3', ['mistral'])).toBe('');
  });
  it('returns empty for an empty pick (defers to saved default)', () => {
    expect(reconcilePick('', ['mistral'])).toBe('');
  });
  it('drops a pick when nothing is installed', () => {
    expect(reconcilePick('llama3', [])).toBe('');
  });
});

describe('draftAfter', () => {
  it('keeps the draft across a dismiss (accidental dismiss must not lose it)', () => {
    expect(draftAfter({ kind: 'dismiss' }, 'what does this do')).toBe('what does this do');
  });
  it('clears the draft after a successful fire', () => {
    expect(draftAfter({ kind: 'fire-success' }, 'what does this do')).toBe('');
  });
  it('clears the draft when a new, different selection is captured (no stale leak)', () => {
    expect(draftAfter({ kind: 'capture', changed: true }, 'about selection A')).toBe('');
  });
  it('keeps the draft when reopening over the same selection', () => {
    expect(draftAfter({ kind: 'capture', changed: false }, 'about selection A')).toBe('about selection A');
  });
});

describe('statusAfterDismiss', () => {
  it('preserves running so a mid-stream dismiss still shows working on reopen', () => {
    expect(statusAfterDismiss('running')).toBe('running');
  });
  it('resets idle/done/error to idle', () => {
    expect(statusAfterDismiss('idle')).toBe('idle');
    expect(statusAfterDismiss('done')).toBe('idle');
    expect(statusAfterDismiss('error')).toBe('idle');
  });
});
