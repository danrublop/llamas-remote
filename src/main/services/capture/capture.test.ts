import { describe, it, expect, vi } from 'vitest';
import { captureViaClipboard, makeHybridProvider, type Clipboard, type CaptureResult } from './capture';

/** In-memory clipboard for tests. */
function fakeClipboard(initial = ''): Clipboard & { value: string } {
  return {
    value: initial,
    readText() {
      return this.value;
    },
    writeText(t: string) {
      this.value = t;
    },
    clear() {
      this.value = '';
    },
  };
}

const noSleep = { sleep: async () => {}, captureDelayMs: 0 };

describe('captureViaClipboard', () => {
  it('captures the selection the synthetic copy produced', async () => {
    const cb = fakeClipboard('user had this');
    const triggerCopy = vi.fn(async () => {
      cb.writeText('the selected text'); // simulate the app responding to Cmd+C
    });

    const res = await captureViaClipboard(cb, triggerCopy, 'Safari', noSleep);

    expect(res.text).toBe('the selected text');
    expect(res.via).toBe('clipboard');
    expect(res.sourceApp).toBe('Safari');
    expect(triggerCopy).toHaveBeenCalledOnce();
  });

  // The guarantee the eng review demanded: the user's clipboard is never destroyed.
  it('restores the original clipboard after capturing', async () => {
    const cb = fakeClipboard('PRECIOUS original clipboard');
    const res = await captureViaClipboard(cb, async () => cb.writeText('selection'), undefined, noSleep);
    expect(res.text).toBe('selection');
    expect(cb.value).toBe('PRECIOUS original clipboard');
  });

  it('restores the original clipboard even when nothing was selected', async () => {
    const cb = fakeClipboard('keep me');
    const res = await captureViaClipboard(cb, async () => {/* app writes nothing */}, undefined, noSleep);
    expect(res.text).toBe('');
    expect(res.via).toBe('none');
    expect(cb.value).toBe('keep me');
  });

  it('restores the original clipboard even when triggerCopy throws', async () => {
    const cb = fakeClipboard('survivor');
    await expect(
      captureViaClipboard(cb, async () => { throw new Error('key send failed'); }, undefined, noSleep),
    ).rejects.toThrow('key send failed');
    expect(cb.value).toBe('survivor');
  });

  it('waits for the hotkey modifiers to clear before the synthetic copy', async () => {
    const order: string[] = [];
    const cb = fakeClipboard('orig');
    const sleep = vi.fn(async (ms: number) => { order.push(`sleep:${ms}`); });
    const triggerCopy = vi.fn(async () => { order.push('copy'); cb.writeText('sel'); });
    await captureViaClipboard(cb, triggerCopy, undefined, { sleep, captureDelayMs: 0, preCopyDelayMs: 250 });
    // The 250ms wait must happen BEFORE the synthetic copy fires.
    expect(order[0]).toBe('sleep:250');
    expect(order.indexOf('sleep:250')).toBeLessThan(order.indexOf('copy'));
  });

  it('treats whitespace-only copies as empty', async () => {
    const cb = fakeClipboard('orig');
    const res = await captureViaClipboard(cb, async () => cb.writeText('   \n  '), undefined, noSleep);
    expect(res.text).toBe('');
    expect(res.via).toBe('none');
    expect(cb.value).toBe('orig');
  });
});

describe('makeHybridProvider', () => {
  it('uses accessibility when it returns text and never touches the clipboard', async () => {
    const cb = fakeClipboard('untouched');
    const triggerCopy = vi.fn(async () => cb.writeText('SHOULD NOT HAPPEN'));
    const provider = makeHybridProvider({
      readAccessibilitySelection: async (): Promise<CaptureResult> => ({ text: 'ax text', via: 'accessibility' }),
      clipboard: cb,
      triggerCopy,
      getSourceApp: () => 'VSCode',
      options: noSleep,
    });

    const res = await provider.captureSelection();
    expect(res.text).toBe('ax text');
    expect(res.via).toBe('accessibility');
    expect(res.sourceApp).toBe('VSCode');
    expect(triggerCopy).not.toHaveBeenCalled();
    expect(cb.value).toBe('untouched');
  });

  it('falls back to clipboard when accessibility returns empty', async () => {
    const cb = fakeClipboard('orig');
    const provider = makeHybridProvider({
      readAccessibilitySelection: async () => ({ text: '', via: 'none' }),
      clipboard: cb,
      triggerCopy: async () => cb.writeText('from clipboard'),
      getSourceApp: () => 'Notes',
      options: noSleep,
    });

    const res = await provider.captureSelection();
    expect(res.text).toBe('from clipboard');
    expect(res.via).toBe('clipboard');
    expect(res.sourceApp).toBe('Notes');
    expect(cb.value).toBe('orig');
  });

  it('falls back to clipboard when accessibility throws (denied/unavailable)', async () => {
    const cb = fakeClipboard('orig');
    const provider = makeHybridProvider({
      readAccessibilitySelection: async () => { throw new Error('AX denied'); },
      clipboard: cb,
      triggerCopy: async () => cb.writeText('recovered'),
      options: noSleep,
    });

    const res = await provider.captureSelection();
    expect(res.text).toBe('recovered');
    expect(res.via).toBe('clipboard');
    expect(cb.value).toBe('orig');
  });

  it('passive mode (allowClipboardFallback:false) never injects a synthetic copy', async () => {
    const cb = fakeClipboard('orig');
    const triggerCopy = vi.fn(async () => cb.writeText('SHOULD NOT HAPPEN'));
    const provider = makeHybridProvider({
      readAccessibilitySelection: async () => ({ text: '', via: 'none' }), // AX found nothing
      clipboard: cb,
      triggerCopy,
      getSourceApp: () => 'Safari',
      options: noSleep,
    });

    const res = await provider.captureSelection({ allowClipboardFallback: false });
    expect(res.text).toBe('');
    expect(res.via).toBe('none');
    expect(res.sourceApp).toBe('Safari');
    expect(triggerCopy).not.toHaveBeenCalled();
    expect(cb.value).toBe('orig');
  });

  it('passive mode still returns an accessibility hit (hover preview works)', async () => {
    const cb = fakeClipboard('orig');
    const provider = makeHybridProvider({
      readAccessibilitySelection: async (): Promise<CaptureResult> => ({ text: 'hovered selection', via: 'accessibility' }),
      clipboard: cb,
      triggerCopy: vi.fn(),
      options: noSleep,
    });

    const res = await provider.captureSelection({ allowClipboardFallback: false });
    expect(res.text).toBe('hovered selection');
    expect(res.via).toBe('accessibility');
  });
});

describe('captureViaClipboard — full-format snapshot/restore', () => {
  // Simulates a clipboard holding a non-text payload (e.g. an image): readText is empty
  // but snapshot/restore round-trips the real contents.
  it('restores all formats, not just text', async () => {
    let store: Record<string, unknown> = { text: '', image: 'PNGDATA' };
    const cb: Clipboard = {
      readText: () => (store.text as string) ?? '',
      writeText: (t) => { store = { text: t }; },
      clear: () => { store = { text: '' }; },
      snapshot: () => ({ ...store }),
      restore: (snap) => { store = { ...(snap as Record<string, unknown>) }; },
    };
    const triggerCopy = async () => { store = { text: 'selected text' }; };

    const res = await captureViaClipboard(cb, triggerCopy, undefined, noSleep);
    expect(res.text).toBe('selected text');
    // The original image clipboard is back, not clobbered by text-only restore.
    expect(store).toEqual({ text: '', image: 'PNGDATA' });
  });
});
