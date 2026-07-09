// Model router (eng review E3 / plan item 8, V1 scope).
//
// V1 is intentionally small: auto-detect vision (image input -> vision model) and
// otherwise honor the preset's model, then the user's picked model, then the global
// default. Full task-based routing (code vs general heuristics) is deferred to a TODO.
// Pure function; no Ollama calls here.

import type { CaptureKind, Preset } from '../presets/presets';

export interface RouterConfig {
  /** Default model for text queries when nothing more specific applies. */
  defaultTextModel: string;
  /** Model used whenever the input is an image. */
  visionModel: string;
}

export interface RouteInput {
  kind: CaptureKind;
  /** The active preset, if the query came from a one-tap action. */
  preset?: Preset;
  /** A model the user explicitly picked in the UI, if any. */
  userSelectedModel?: string;
}

export interface RouteResult {
  model: string;
  /** Why this model was chosen — surfaced in logs and (optionally) the UI. */
  reason: string;
}

// Known vision-capable models. Cloud entries are matched by the picker's prefixed ids
// (multi-llm-client.CLOUD_MODELS); local entries are matched as substrings of the Ollama
// tag (so `llava:latest`, `llama3.2-vision:11b`, etc. all qualify). Conservative by design:
// a model we don't recognize is treated as text-only and images fall back to local vision.
const CLOUD_VISION = new Set([
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'anthropic/claude-sonnet-4-5',
  // Haiku 4.5 accepts image input (standard-resolution vision tier). The retired
  // claude-3-5-haiku was text-only and was wrongly listed here.
  'anthropic/claude-haiku-4-5',
]);
const LOCAL_VISION_HINTS = ['llava', 'bakllava', 'vision', 'moondream', 'minicpm-v', 'qwen2-vl', 'qwen2.5vl'];

/** True if `model` can accept image input (cloud allow-list or a known local vision tag). */
export function isVisionCapable(model: string | undefined): boolean {
  if (!model) return false;
  if (CLOUD_VISION.has(model)) return true;
  const lower = model.toLowerCase();
  return LOCAL_VISION_HINTS.some((h) => lower.includes(h));
}

/**
 * Resolve which model should answer this query.
 *
 * Precedence:
 *   image + user picked a vision-capable model -> that model   (cloud or local; honor the pick)
 *   image + picked model can't see (or none)   -> visionModel  (fall back to local vision)
 *   text  + userSelectedModel                  -> that model   (explicit pick wins)
 *   text  + preset.defaultModel                -> that model
 *   text  (nothing else)                       -> defaultTextModel
 */
export function routeModel(input: RouteInput, config: RouterConfig): RouteResult {
  if (input.kind === 'image') {
    // Honor a vision-capable pick (e.g. gpt-4o, claude) so the user isn't silently
    // switched to local llava. Only force the local vision model when the picked model
    // can't see — otherwise the request would fail confusingly.
    if (isVisionCapable(input.userSelectedModel)) {
      return { model: input.userSelectedModel as string, reason: 'user-selected vision-capable model' };
    }
    return { model: config.visionModel, reason: 'image input routed to local vision model' };
  }

  if (input.userSelectedModel) {
    return { model: input.userSelectedModel, reason: 'user-selected model' };
  }

  if (input.preset?.defaultModel) {
    return { model: input.preset.defaultModel, reason: `preset "${input.preset.id}" default model` };
  }

  return { model: config.defaultTextModel, reason: 'default text model' };
}
