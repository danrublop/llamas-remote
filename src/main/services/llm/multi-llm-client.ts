// Routes a query to the right provider based on the model id:
//   "openai/gpt-4o"            -> OpenAI
//   "anthropic/claude-..."     -> Anthropic
//   "mistral:latest" (no /)    -> Ollama (local)
//
// Implements the LlmClient port so NotchController is provider-agnostic.

import type { LlmClient, ChatMessage } from '../notch/notch-controller';

export type Provider = 'openai' | 'anthropic' | 'ollama';

export function parseModel(model: string): { provider: Provider; id: string } {
  if (model.startsWith('openai/')) return { provider: 'openai', id: model.slice('openai/'.length) };
  if (model.startsWith('anthropic/')) return { provider: 'anthropic', id: model.slice('anthropic/'.length) };
  return { provider: 'ollama', id: model };
}

/** Curated hosted models offered in the picker when the provider's key is set. */
export const CLOUD_MODELS: Record<'openai' | 'anthropic', string[]> = {
  openai: ['openai/gpt-4o', 'openai/gpt-4o-mini'],
  anthropic: ['anthropic/claude-sonnet-4-5', 'anthropic/claude-haiku-4-5'],
};

export class MultiLlmClient implements LlmClient {
  constructor(private readonly deps: { ollama: LlmClient; openai: LlmClient; anthropic: LlmClient }) {}

  async generate(opts: { model: string; prompt: string; imagePath?: string; messages?: ChatMessage[]; system?: string; onToken?: (delta: string) => void; signal?: AbortSignal }): Promise<string> {
    const { provider, id } = parseModel(opts.model);
    const client = provider === 'openai' ? this.deps.openai : provider === 'anthropic' ? this.deps.anthropic : this.deps.ollama;
    return client.generate({ ...opts, model: id });
  }
}
