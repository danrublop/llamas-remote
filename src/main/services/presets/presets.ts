// Action presets (eng review E3, plan "Preset shape").
//
// A preset is a named prompt template the notch panel offers as a one-tap action.
// Templates interpolate {selection} (captured text) and {image} (captured screenshot
// reference). `accepts` declares which capture kinds the preset is valid for, so the
// UI can disable presets that don't fit the current input. Presets are pure data +
// pure render/validation functions here; persistence (user-editable JSON) lives in the
// caller.

export type PresetAccepts = 'text' | 'image' | 'both';
export type CaptureKind = 'text' | 'image';

export interface Preset {
  id: string;
  name: string;
  /** Prompt template; may contain {selection} and/or {image} tokens. */
  promptTemplate: string;
  accepts: PresetAccepts;
  /** Optional model override; the router falls back to this before the global default. */
  defaultModel?: string;
}

export const BUILT_IN_PRESETS: readonly Preset[] = [
  { id: 'explain', name: 'Explain', accepts: 'both', promptTemplate: 'Explain the following clearly and concisely:\n\n{selection}' },
  { id: 'summarize', name: 'Summarize', accepts: 'both', promptTemplate: 'Summarize the following in a few sentences:\n\n{selection}' },
  { id: 'rewrite', name: 'Rewrite', accepts: 'text', promptTemplate: 'Rewrite the following to be clearer and more direct, preserving meaning:\n\n{selection}' },
  { id: 'translate', name: 'Translate', accepts: 'text', promptTemplate: 'Translate the following to English (or to the user\'s language if already English):\n\n{selection}' },
  { id: 'find-bugs', name: 'Find bugs', accepts: 'text', promptTemplate: 'Review the following code for bugs and edge cases. List concrete issues and fixes:\n\n{selection}' },
];

/** Whether a preset can handle a given capture kind. */
export function canHandle(preset: Preset, kind: CaptureKind): boolean {
  return preset.accepts === 'both' || preset.accepts === kind;
}

export interface RenderVars {
  selection?: string;
  /** A reference/marker for the image (the actual image bytes go to the model separately). */
  image?: string;
}

/**
 * Interpolate {selection} and {image} tokens in a template. Missing vars render as the
 * empty string. Unknown tokens (e.g. {foo}) are left untouched so a typo in a user
 * preset is visible rather than silently eaten. The result is trimmed of trailing
 * whitespace left by an empty token at the end.
 */
export function renderPrompt(template: string, vars: RenderVars): string {
  // Clean up per-line trailing whitespace on the TEMPLATE only — never across the
  // interpolated user content, which would strip Markdown hard line-breaks (trailing
  // double-space) out of the captured selection. Then trimEnd the final result to drop
  // any dangling whitespace/newlines left by an empty token at the end.
  return template
    .replace(/[ \t]+$/gm, '')
    .replace(/\{selection\}/g, vars.selection ?? '')
    .replace(/\{image\}/g, vars.image ?? '')
    .trimEnd();
}
