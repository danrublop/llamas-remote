// macOS CaptureProvider wiring (runtime).
//
// Hybrid strategy (see capture.ts for the tested orchestration):
//   1. PASSIVE accessibility read via `selection-hook` (AXAPI) — no keystroke, no clipboard
//      touch. Used on every trigger including hover.
//   2. SYNTHETIC Cmd+C fallback — only when the AX read finds nothing AND the trigger is
//      explicit (hotkey / action button). Snapshots & restores ALL clipboard formats.
//
// `selection-hook` is a native module; like better-sqlite3 it must be built for the
// Electron ABI. We lazy-load it in a try/catch so a load/build failure degrades to the
// clipboard path instead of crashing the app.
//
// Shells out with execFile + fixed arguments (no shell, no user input) for the Cmd+C
// fallback and the frontmost-app query, so there is no command-injection surface.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { clipboard } from 'electron';
import { makeHybridProvider, type CaptureProvider, type CaptureResult, type Clipboard } from './capture';

const run = promisify(execFile);

async function osascript(script: string): Promise<string> {
  const { stdout } = await run('osascript', ['-e', script], { timeout: 4000 });
  return stdout.trim();
}

/** Synthesize Cmd+C in the frontmost app. Throws a clear error naming BOTH permissions. */
async function triggerCopy(): Promise<void> {
  try {
    await osascript('tell application "System Events" to keystroke "c" using {command down}');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[capture] osascript keystroke failed:', msg);
    // 1002/-25211 = not trusted for Accessibility; -1743 = Automation not allowed.
    throw new Error(
      'Could not read the selection. Grant BOTH Accessibility and Automation to this app in ' +
        'System Settings → Privacy & Security (in dev that\'s "Electron"), then try again.',
    );
  }
}

/** Name of the frontmost application, for tagging. Best-effort. */
async function getSourceApp(): Promise<string | undefined> {
  try {
    return (await osascript('tell application "System Events" to get name of first process whose frontmost is true')) || undefined;
  } catch {
    return undefined;
  }
}

// ── selection-hook (native AX reader) ────────────────────────────────────────
// Loaded + started once, lazily. `hook` stays null if the module can't load or start
// (missing build, ABI mismatch, denied permission) — the hybrid provider then falls back.

interface SelectionHookInstance {
  start(config?: unknown): boolean;
  getCurrentSelection(): { text: string; programName?: string } | null;
  macIsProcessTrusted?(): boolean;
}

let hook: SelectionHookInstance | null = null;
let hookTried = false;

function getHook(): SelectionHookInstance | null {
  if (hookTried) return hook;
  hookTried = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('selection-hook');
    const SelectionHook = mod.default ?? mod;
    const instance: SelectionHookInstance = new SelectionHook();
    // CRITICAL: disable the native module's built-in clipboard fallback. Left at its default
    // (enableClipboard: true), `getCurrentSelection()` injects a synthetic Cmd+C and reads the
    // clipboard whenever the AX read comes back empty — even on a passive hover trigger. That
    // breaks the "passive AX read, no keystroke, no clipboard touch" contract (capture.ts) and
    // janks the main thread. We own the synthetic-copy fallback in the tested JS orchestration
    // (capture.ts), gated on an explicit user action; the native layer must never do its own.
    if (instance.start({ enableClipboard: false })) {
      hook = instance;
    } else {
      console.warn('[capture] selection-hook start() returned false; using clipboard fallback.');
    }
  } catch (e) {
    console.warn('[capture] selection-hook unavailable; using clipboard fallback.', e);
  }
  return hook;
}

/** Has the user granted Accessibility? Used to decide whether to prompt. */
export function isAccessibilityTrusted(): boolean {
  const h = getHook();
  try {
    return h?.macIsProcessTrusted?.() ?? false;
  } catch {
    return false;
  }
}

/** Read the selection via the native AX API. Returns null when nothing is selected. */
async function readAccessibilitySelection(): Promise<CaptureResult | null> {
  const h = getHook();
  if (!h) return null;
  const sel = h.getCurrentSelection();
  if (sel && typeof sel.text === 'string' && sel.text.trim().length > 0) {
    return { text: sel.text, sourceApp: sel.programName, via: 'accessibility' };
  }
  return null;
}

// Full-format clipboard adapter: snapshots/restores text + HTML + RTF + image so a
// non-text clipboard survives the synthetic-copy fallback.
interface ClipboardSnapshot {
  text: string;
  html: string;
  rtf: string;
  image: Electron.NativeImage;
}

function makeClipboardAdapter(): Clipboard {
  return {
    readText: () => clipboard.readText(),
    writeText: (t) => clipboard.writeText(t),
    clear: () => clipboard.clear(),
    snapshot: (): ClipboardSnapshot => ({
      text: clipboard.readText(),
      html: clipboard.readHTML(),
      rtf: clipboard.readRTF(),
      image: clipboard.readImage(),
    }),
    restore: (snap: unknown) => {
      const s = snap as ClipboardSnapshot;
      const data: Electron.Data = {};
      if (s.text) data.text = s.text;
      if (s.html) data.html = s.html;
      if (s.rtf) data.rtf = s.rtf;
      if (s.image && !s.image.isEmpty()) data.image = s.image;
      if (Object.keys(data).length === 0) clipboard.clear(); // was empty — don't leave our copy behind
      else clipboard.write(data);
    },
  };
}

let cachedSourceApp: string | undefined;

/**
 * Build the macOS capture provider. Source app is sampled just before capture so the
 * tag reflects the app the selection came from.
 */
export function createMacCaptureProvider(): CaptureProvider {
  const hybrid = makeHybridProvider({
    readAccessibilitySelection,
    clipboard: makeClipboardAdapter(),
    triggerCopy,
    getSourceApp: () => cachedSourceApp,
  });
  return {
    async captureSelection(opts): Promise<CaptureResult> {
      cachedSourceApp = await getSourceApp();
      const res = await hybrid.captureSelection(opts);
      console.log(`[capture] via=${res.via} chars=${res.text.length} sourceApp=${res.sourceApp ?? '?'}`);
      return res;
    },
  };
}
