// Verifies the multi-turn (messages[]) path each provider client builds, and that the
// single-prompt path is unchanged. We intercept axios.post to capture the request body
// without hitting the network, and feed back a minimal provider-shaped stream.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import axios from 'axios';
import { OllamaLlmClient } from './ollama-llm-client';
import { OpenAiLlmClient } from './openai-llm-client';
import { AnthropicLlmClient } from './anthropic-llm-client';

vi.mock('axios');
const mockedPost = vi.mocked(axios.post);
// The clients call axios.isCancel/isAxiosError in catch; keep them false for the happy path.
vi.mocked(axios.isCancel).mockReturnValue(false);
vi.mocked(axios.isAxiosError).mockReturnValue(false as never);

function streamOf(lines: string[]): { data: Readable } {
  return { data: Readable.from(lines.map((l) => l + '\n')) } as never;
}

let lastBody: Record<string, unknown>;
let lastUrl: string;
function capture(reply: string[]) {
  mockedPost.mockImplementation((url: string, body: unknown) => {
    lastUrl = url;
    lastBody = body as Record<string, unknown>;
    return Promise.resolve(streamOf(reply));
  });
}

const HISTORY = [
  { role: 'user' as const, content: 'hi' },
  { role: 'assistant' as const, content: 'hello' },
  { role: 'user' as const, content: 'what are my notes about?' },
];

beforeEach(() => { mockedPost.mockReset(); });

describe('Ollama multi-turn', () => {
  it('POSTs /api/chat with system + history and reads message.content deltas', async () => {
    capture([JSON.stringify({ message: { content: 'answer' } }), JSON.stringify({ done: true })]);
    const out = await new OllamaLlmClient().generate({ model: 'mistral', prompt: '', messages: HISTORY, system: 'ctx' });
    expect(lastUrl).toContain('/api/chat');
    expect(lastBody.messages).toEqual([{ role: 'system', content: 'ctx' }, ...HISTORY]);
    expect(out).toBe('answer');
  });

  it('single-prompt path still uses /api/generate', async () => {
    capture([JSON.stringify({ response: 'x' }), JSON.stringify({ done: true })]);
    await new OllamaLlmClient().generate({ model: 'mistral', prompt: 'just this' });
    expect(lastUrl).toContain('/api/generate');
    expect(lastBody.prompt).toBe('just this');
    expect(lastBody.messages).toBeUndefined();
  });
});

describe('OpenAI multi-turn', () => {
  it('prepends system and sends full history', async () => {
    capture(['data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]']);
    await new OpenAiLlmClient(() => 'key').generate({ model: 'gpt-4o', prompt: '', messages: HISTORY, system: 'ctx' });
    expect(lastBody.messages).toEqual([{ role: 'system', content: 'ctx' }, ...HISTORY]);
  });

  it('single-prompt path sends one user turn, no system', async () => {
    capture(['data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]']);
    await new OpenAiLlmClient(() => 'key').generate({ model: 'gpt-4o', prompt: 'solo' });
    expect(lastBody.messages).toEqual([{ role: 'user', content: 'solo' }]);
  });
});

describe('Anthropic multi-turn', () => {
  it('sends history + top-level system', async () => {
    capture([
      'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { text: 'ok' } }),
      'data: ' + JSON.stringify({ type: 'message_stop' }),
    ]);
    await new AnthropicLlmClient(() => 'key').generate({ model: 'claude', prompt: '', messages: HISTORY, system: 'ctx' });
    expect(lastBody.messages).toEqual(HISTORY);
    expect(lastBody.system).toBe('ctx');
  });

  it('single-prompt path sets no system field', async () => {
    capture([
      'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { text: 'ok' } }),
      'data: ' + JSON.stringify({ type: 'message_stop' }),
    ]);
    await new AnthropicLlmClient(() => 'key').generate({ model: 'claude', prompt: 'solo' });
    expect(lastBody.system).toBeUndefined();
    expect(lastBody.messages).toEqual([{ role: 'user', content: 'solo' }]);
  });
});
