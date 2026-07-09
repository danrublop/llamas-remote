// Anthropic (Claude) chat client implementing the LlmClient port (text only). Streams SSE.

import axios from 'axios';
import { readFileSync } from 'fs';
import { extname } from 'path';
import type { LlmClient } from '../notch/notch-controller';
import { readStreamErrorMessage } from './stream-error';
import { withRetry } from './retry';

/** Anthropic message content: text string, or a text+image block array when an image is attached. */
function buildContent(prompt: string, imagePath?: string): unknown {
  if (!imagePath) return prompt;
  const ext = extname(imagePath).slice(1).toLowerCase() || 'png';
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  const b64 = readFileSync(imagePath).toString('base64');
  return [
    { type: 'image', source: { type: 'base64', media_type: `image/${mime}`, data: b64 } },
    { type: 'text', text: prompt },
  ];
}

export class AnthropicLlmClient implements LlmClient {
  constructor(private readonly getKey: () => string | undefined) {}

  async generate(opts: { model: string; prompt: string; imagePath?: string; onToken?: (delta: string) => void; signal?: AbortSignal }): Promise<string> {
    const key = this.getKey();
    if (!key) throw new Error('No Anthropic API key — add one in Settings.');
    // Per-model output ceiling. 4096 silently truncated long answers; these are the real caps.
    // Haiku 4.5 streams up to 64k output (the retired Haiku 3.5 capped at 8192); Sonnet 4.x
    // streams up to 64k. Both curated cloud models (see multi-llm-client CLOUD_MODELS) now
    // support 64k, so a flat 64000 is safe. A newly-added low-ceiling Anthropic model (e.g. a
    // future 8192-cap tier) would 400 above its cap and need special-casing here.
    const maxTokens = 64000;
    try {
      // Retry only the request-establishment call — never the stream read below (see retry.ts).
      const res = await withRetry(
        () => axios.post(
          'https://api.anthropic.com/v1/messages',
          { model: opts.model, max_tokens: maxTokens, stream: true, messages: [{ role: 'user', content: buildContent(opts.prompt, opts.imagePath) }] },
          {
            headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            responseType: 'stream',
            timeout: 120000,
            signal: opts.signal,
          },
        ),
        { signal: opts.signal },
      );
      const stream = res.data;
      return await new Promise<string>((resolve, reject) => {
        let full = '';
        let buffer = '';
        let settled = false;
        let stopReason: string | undefined; // arrives on message_delta, read on message_stop
        // Destroy the socket + detach listeners on the terminal event so trailing SSE events
        // after message_stop can't keep calling onToken once we've resolved.
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          stream.removeListener('data', onData);
          stream.removeListener('end', onEnd);
          stream.removeListener('error', onError);
          stream.destroy();
          fn();
        };
        const onData = (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            try {
              const evt = JSON.parse(t.slice(5).trim());
              if (evt.type === 'content_block_delta' && typeof evt.delta?.text === 'string') {
                full += evt.delta.text;
                opts.onToken?.(evt.delta.text); // delta chunk, not cumulative
              } else if (evt.type === 'error') {
                // Anthropic streams overloaded/rate-limit errors in-band over a 200 response.
                finish(() => reject(new Error(`Anthropic stream error: ${evt.error?.message || 'unknown error'}`)));
                return;
              } else if (evt.type === 'message_delta' && typeof evt.delta?.stop_reason === 'string') {
                stopReason = evt.delta.stop_reason;
              } else if (evt.type === 'message_stop') {
                // Anthropic ends a length-capped answer with a normal message_stop, so a
                // truncated response would otherwise resolve as if it were complete. Mark it.
                if (stopReason === 'max_tokens') {
                  const marker = '\n\n_(truncated — response hit the length limit)_';
                  full += marker;
                  opts.onToken?.(marker);
                }
                finish(() => resolve(full));
                return;
              }
            } catch { /* skip */ }
          }
        };
        // Connection closed without message_stop: the stream was cut short, so don't pass a
        // truncated answer back as a successful completion.
        const onEnd = () => finish(() => (full
          ? reject(new Error('Anthropic stream ended before completion (truncated response).'))
          : reject(new Error('No response received from Anthropic'))));
        const onError = (e: Error) => finish(() => reject(opts.signal?.aborted ? new Error('cancelled') : new Error(`Anthropic stream error: ${e.message}`)));
        stream.on('data', onData);
        stream.on('end', onEnd);
        stream.on('error', onError);
      });
    } catch (error) {
      if (axios.isCancel(error)) throw new Error('cancelled');
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) throw new Error('Anthropic rejected the API key (401).');
        // The body is a stream (responseType: 'stream'); read it for the real reason.
        const detail = await readStreamErrorMessage(error.response?.data);
        const status = error.response?.status;
        throw new Error(`Anthropic API error${status ? ` (${status})` : ''}: ${detail || error.message}`);
      }
      throw error;
    }
  }
}
