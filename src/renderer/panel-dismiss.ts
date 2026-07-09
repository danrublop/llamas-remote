// Pure decision logic for the notch panel's dismiss + state-reload behavior.
//
// This module holds ZERO React/Electron dependencies so it can be unit-tested in the
// node vitest env (matching src/renderer/editor/*.ts). panel.tsx wires DOM events to
// these functions; the functions decide what should happen.
//
// Why this exists: the panel's dismiss was unreliable because it leaned on Electron's
// `blur` event, which macOS does not reliably emit for alwaysOnTop + type:'panel'
// windows. The fix funnels several triggers (Esc, window-blur, click-close, main-blur,
// mouse-leave) into one collapse. Centralizing the *decisions* here keeps that fan-in
// honest and tested.

export type Status = 'idle' | 'running' | 'done' | 'error';

/** Result of an Escape keypress, given the panel's current UI state. */
export type EscapeAction = 'close-input' | 'collapse' | 'noop';

/**
 * Two-stage Escape:
 *   1. if the ask input is open, Esc closes it (stage 1);
 *   2. else if the panel is expanded, Esc melts it to the resting nub (stage 2);
 *   3. otherwise nothing.
 * Esc deliberately ignores `pinnedRef` — it is an explicit user dismiss.
 */
export function decideEscapeAction(state: { typing: boolean; expanded: boolean }): EscapeAction {
  if (state.typing) return 'close-input';
  if (state.expanded) return 'collapse';
  return 'noop';
}

/**
 * Window-blur dismiss. Collapse on focus loss UNLESS a native capture (screenshot / OCR /
 * file picker) is in flight — those legitimately blur the window and must not self-dismiss
 * the panel.
 */
export function decideBlurAction(state: { captureInFlight: boolean }): 'collapse' | 'noop' {
  return state.captureInFlight ? 'noop' : 'collapse';
}

/**
 * Reconcile the user's explicit model pick against the installed list.
 * - pick still installed -> keep it
 * - pick no longer installed (or never set) -> '' (empty = defer to the saved default;
 *   we never auto-select the first model)
 * This is the half of the old `refreshModels` that must run on every expand even when the
 * list is served from cache, so `model` can never point at an uninstalled model.
 */
export function reconcilePick(pick: string, installed: string[]): string {
  return pick && installed.includes(pick) ? pick : '';
}

/** Events that affect whether a user's in-progress draft (freeText/attachments) survives. */
export type DraftEvent =
  | { kind: 'dismiss' } // melt to nub — keep the draft so an accidental dismiss doesn't lose it
  | { kind: 'fire-success' } // query sent — the draft did its job, clear it
  | { kind: 'capture'; changed: boolean }; // new selection captured — clear only if it differs

/**
 * Decide the next draft value after an event. Returns the draft to keep, or '' to clear.
 * The `capture.changed` guard prevents a half-typed question about selection A from
 * leaking onto a freshly captured selection B, while still preserving the draft when you
 * reopen over the same selection.
 */
export function draftAfter(event: DraftEvent, draft: string): string {
  switch (event.kind) {
    case 'dismiss':
      return draft;
    case 'fire-success':
      return '';
    case 'capture':
      return event.changed ? '' : draft;
  }
}

/**
 * Status to keep when melting to the nub. A dismiss mid-stream keeps `running` (the answer
 * is still streaming into the notebook), so reopening the panel still shows the working
 * indicator instead of looking idle. Any other status resets to idle.
 */
export function statusAfterDismiss(current: Status): Status {
  return current === 'running' ? 'running' : 'idle';
}

/** How a settled fire() should resolve, given the run-id guard + the run's result. */
export type FireOutcome = 'ignore' | 'success' | 'cancelled' | 'error';

/**
 * Decide what a fire() should do once its query settles. Mirrors the run-id guard main.ts
 * uses server-side: each fire() is tagged with a monotonic id, so if a NEWER fire has since
 * started (`superseded`) this stale result is ignored — it must not paint over the newer run.
 *
 * Otherwise: `ok` -> success; a resolved `error === 'cancelled'` (the run was superseded/closed
 * deliberately, and main already suppressed the notebook:error) -> a no-op, never a red "error";
 * anything else -> a real error the user should see. The same function classifies a rejected
 * IPC invoke — pass `ok: false` with the thrown message so a hard reject can't hang on 'running'.
 */
export function classifyFireOutcome(params: {
  superseded: boolean;
  ok?: boolean;
  error?: string;
}): FireOutcome {
  if (params.superseded) return 'ignore';
  if (params.ok) return 'success';
  if (params.error === 'cancelled') return 'cancelled';
  return 'error';
}
