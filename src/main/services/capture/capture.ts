// Selection capture (eng review E1/E5).
//
// Strategy: try the native accessibility path first (via the `selection-hook` library,
// wired in the real provider), and fall back to a synthetic Cmd+C that NEVER destroys
// the user's clipboard. selection-hook is kept behind the CaptureProvider interface so
// it can be swapped for a custom native helper later without touching callers.
//
// Capture is ON-DEMAND only (eng review E4): we read the selection when the hotkey
// fires, never via continuous monitoring — better battery, and the app never inspects
// a selection the user didn't ask about.
//
// This file holds the interface plus the clipboard-fallback orchestration. The fallback
// is written against injected Clipboard + triggerCopy + sleep so every branch (including
// the "clipboard is restored" guarantee) is unit-testable without a real OS.

export interface CaptureResult {
  /** Selected text, or empty string if nothing could be read. */
  text: string;
  /** Frontmost app bundle id / name, if known (used for auto-tagging). */
  sourceApp?: string;
  /** Which path produced the result — for observability. */
  via: 'accessibility' | 'clipboard' | 'none';
}

export interface CaptureOptions {
  /**
   * Whether the synthetic-Cmd+C clipboard fallback may run if the accessibility read
   * yields nothing. Passive triggers (hover) pass `false` so we never inject a keystroke
   * or thrash the clipboard just because the panel opened; explicit triggers (hotkey,
   * action button) pass `true`. Defaults to `true`.
   */
  allowClipboardFallback?: boolean;
}

export interface CaptureProvider {
  /** Read the current selection on demand. Resolves with empty text if none. */
  captureSelection(opts?: CaptureOptions): Promise<CaptureResult>;
}

/**
 * Minimal clipboard surface (Electron's `clipboard` satisfies the required methods).
 * `snapshot`/`restore` are optional: when provided they preserve ALL clipboard formats
 * (image/RTF/HTML), not just text. Tests inject the text-only subset.
 */
export interface Clipboard {
  readText(): string;
  writeText(text: string): void;
  clear(): void;
  /** Capture every clipboard format so a non-text clipboard isn't lost on capture. */
  snapshot?(): unknown;
  /** Put a snapshot back exactly as it was. */
  restore?(snap: unknown): void;
}

export interface ClipboardCaptureOptions {
  /** ms to wait after the synthetic copy for the focused app to write the clipboard. */
  captureDelayMs?: number;
  /**
   * ms to wait BEFORE the synthetic copy. The clipboard fallback runs on the global hotkey
   * (⌘⇧Space), so the user is often still physically holding ⌘+Shift when we fire the
   * synthetic ⌘C — macOS ORs the held Shift in, turning it into ⌘⇧C, which copies nothing.
   * A short wait lets the modifiers release first. ponytail: fixed delay, not modifier-state
   * polling (no simple Electron API for that); a very slow key release still misses.
   */
  preCopyDelayMs?: number;
  /** Injected sleep so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Capture the selection by simulating Cmd+C, reading the clipboard, then restoring the
 * user's original clipboard contents. Always restores, even when nothing was selected
 * or when an error is thrown mid-flight.
 *
 * @param clipboard    clipboard to read/write/clear
 * @param triggerCopy  fires the synthetic copy (real impl sends Cmd+C); resolves when sent
 * @param sourceApp    frontmost app, if the caller already knows it
 */
export async function captureViaClipboard(
  clipboard: Clipboard,
  triggerCopy: () => Promise<void>,
  sourceApp?: string,
  options: ClipboardCaptureOptions = {},
): Promise<CaptureResult> {
  const sleep = options.sleep ?? defaultSleep;
  const delay = options.captureDelayMs ?? 150;
  const preCopyDelay = options.preCopyDelayMs ?? 0;

  // Save the user's clipboard so we can put it back no matter what happens. Prefer the
  // full-format snapshot (preserves an image/RTF/HTML clipboard); fall back to text-only
  // when the injected clipboard doesn't support it (unit tests).
  const useFullSnapshot = typeof clipboard.snapshot === 'function' && typeof clipboard.restore === 'function';
  const saved: unknown = useFullSnapshot ? clipboard.snapshot!() : clipboard.readText();
  try {
    // Let the hotkey's ⌘+Shift release before we synthesize ⌘C (see preCopyDelayMs).
    if (preCopyDelay > 0) await sleep(preCopyDelay);
    // Clear first so a stale value isn't mistaken for the selection.
    clipboard.clear();
    await triggerCopy();
    await sleep(delay);
    const captured = clipboard.readText();
    const text = captured.trim();
    if (text.length === 0) {
      return { text: '', sourceApp, via: 'none' };
    }
    return { text: captured, sourceApp, via: 'clipboard' };
  } finally {
    // Restore the original clipboard. This runs on success, empty, and error paths.
    if (useFullSnapshot) clipboard.restore!(saved);
    else clipboard.writeText(saved as string);
  }
}

/**
 * Compose an accessibility-first provider with a clipboard fallback. Tries the native
 * read; if it yields no text, falls back to synthetic copy. The accessibility reader and
 * triggerCopy are injected so the real provider supplies selection-hook + a key sender.
 */
export function makeHybridProvider(deps: {
  readAccessibilitySelection: () => Promise<CaptureResult | null>;
  clipboard: Clipboard;
  triggerCopy: () => Promise<void>;
  getSourceApp?: () => string | undefined;
  options?: ClipboardCaptureOptions;
}): CaptureProvider {
  return {
    async captureSelection(opts: CaptureOptions = {}): Promise<CaptureResult> {
      const sourceApp = deps.getSourceApp?.();
      try {
        const ax = await deps.readAccessibilitySelection();
        if (ax && ax.text.trim().length > 0) {
          return { ...ax, sourceApp: ax.sourceApp ?? sourceApp, via: 'accessibility' };
        }
      } catch {
        // Accessibility unavailable or denied — fall through to clipboard (if allowed).
      }
      // Passive triggers (hover) skip the synthetic Cmd+C so we never inject a keystroke
      // or disturb the clipboard just because the panel opened.
      if (opts.allowClipboardFallback === false) {
        return { text: '', sourceApp, via: 'none' };
      }
      return captureViaClipboard(deps.clipboard, deps.triggerCopy, sourceApp, deps.options);
    },
  };
}
