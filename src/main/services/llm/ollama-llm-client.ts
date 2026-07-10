// Ollama adapter implementing the NotchController's LlmClient port.
//
// Generic over model + prompt (the notch flow routes the model itself, unlike the legacy
// explanation service which hardcoded mistral). Supports vision by passing a base64 image
// in the `images` field of /api/generate. Streams NDJSON and reports cumulative partials
// via onToken. Thin runtime adapter — verified by running the app, not unit tests.

import axios from 'axios';
import { readFileSync } from 'fs';
import type { LlmClient, ChatMessage } from '../notch/notch-controller';
import { readStreamErrorMessage } from './stream-error';

const BASE_URL = 'http://127.0.0.1:11434';
const TIMEOUT_MS = 300000;
// A pull has no overall deadline (large models take a while), but if no chunk arrives for
// this long the connection is wedged — reject instead of hanging forever on timeout:0.
const PULL_IDLE_MS = 60000;

export class OllamaLlmClient implements LlmClient {
  /** List locally installed model names (for the panel's model picker). Empty on failure. */
  async listModels(): Promise<string[]> {
    try {
      const { data } = await axios.get(`${BASE_URL}/api/tags`, { timeout: 4000 });
      const models = (data?.models ?? []) as Array<{ name: string }>;
      return models.map((m) => m.name).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Installed models with on-disk size (for the Models page RAM-fit badges). Empty on failure. */
  async listModelsDetailed(): Promise<Array<{ name: string; sizeBytes: number }>> {
    try {
      const { data } = await axios.get(`${BASE_URL}/api/tags`, { timeout: 4000 });
      const models = (data?.models ?? []) as Array<{ name: string; size?: number }>;
      return models.filter((m) => m.name).map((m) => ({ name: m.name, sizeBytes: m.size ?? 0 }));
    } catch {
      return [];
    }
  }

  /** Delete an installed model (DELETE /api/delete). Throws on failure. */
  async deleteModel(name: string): Promise<void> {
    await axios.delete(`${BASE_URL}/api/delete`, { data: { name }, timeout: 10000 });
  }

  /** Pull a model via /api/pull, streaming progress. Resolves when complete. */
  async pullModel(name: string, onProgress?: (status: string, percent: number) => void): Promise<void> {
    const res = await axios.post(`${BASE_URL}/api/pull`, { name, stream: true }, { responseType: 'stream', timeout: 0 });
    return await new Promise<void>((resolve, reject) => {
      let buffer = '';
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      // Terminate on the first terminal event: stop the socket, clear the idle timer, and
      // detach — so an {error} line stops buffering and a stalled pull can't hang forever.
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (idleTimer) clearTimeout(idleTimer);
        res.data.destroy();
        fn();
      };
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => finish(() => reject(new Error(`Ollama pull stalled (no progress for ${PULL_IDLE_MS / 1000}s).`))),
          PULL_IDLE_MS,
        );
      };
      resetIdle();
      res.data.on('data', (chunk: Buffer) => {
        resetIdle();
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line);
            const pct = d.total ? Math.round((d.completed ?? 0) / d.total * 100) : 0;
            onProgress?.(String(d.status ?? ''), pct);
            // Ollama reports pull failures as an {"error":...} line over HTTP 200; reject and
            // stop rather than continuing to buffer to a false "success" at stream end.
            if (d.error) { finish(() => reject(new Error(d.error))); return; }
          } catch { /* skip */ }
        }
      });
      res.data.on('end', () => finish(() => resolve()));
      res.data.on('error', (e: Error) => finish(() => reject(new Error(`Ollama pull error: ${e.message}`))));
    });
  }

  async generate(opts: {
    model: string;
    prompt: string;
    imagePath?: string;
    messages?: ChatMessage[];
    system?: string;
    onToken?: (delta: string) => void;
    signal?: AbortSignal;
  }): Promise<string> {
    // Multi-turn → /api/chat (role-tagged messages); single prompt → /api/generate (unchanged).
    const chat = !!opts.messages;
    const body: Record<string, unknown> = chat
      ? {
          model: opts.model,
          messages: [
            ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
            ...opts.messages!,
          ],
          stream: true,
          options: { temperature: 0.7, top_p: 0.9 },
        }
      : {
          model: opts.model,
          prompt: opts.prompt,
          stream: true,
          options: { temperature: 0.7, top_p: 0.9 },
        };
    if (!chat && opts.imagePath) {
      body.images = [readFileSync(opts.imagePath).toString('base64')];
    }

    try {
      const response = await axios.post(`${BASE_URL}/${chat ? 'api/chat' : 'api/generate'}`, body, {
        timeout: TIMEOUT_MS,
        responseType: 'stream',
        signal: opts.signal,
      });

      const stream = response.data;
      return await new Promise<string>((resolve, reject) => {
        let full = '';
        let buffer = '';
        let settled = false;
        // Stop the socket and detach listeners on the first terminal event, so post-`done`
        // chunks can't keep firing onToken (ghost tokens) after we've resolved.
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
            if (!line.trim()) continue;
            try {
              const data = JSON.parse(line);
              // /api/generate streams `response`; /api/chat streams `message.content`.
              const delta = chat ? data.message?.content : data.response;
              if (typeof delta === 'string') {
                full += delta;
                opts.onToken?.(delta); // delta chunk, not cumulative
              }
              if (data.done) { finish(() => resolve(full)); return; }
            } catch {
              // skip malformed line
            }
          }
        };
        // Stream ended without a `done:true` marker: the generation was cut short. Treat it
        // as a failure rather than silently persisting a partial answer as if complete.
        const onEnd = () => finish(() => reject(new Error(
          full ? 'Ollama stream ended before completion (truncated response).' : 'No response received from Ollama',
        )));
        const onError = (err: Error) => finish(() => reject(opts.signal?.aborted ? new Error('cancelled') : new Error(`Ollama stream error: ${err.message}`)));
        stream.on('data', onData);
        stream.on('end', onEnd);
        stream.on('error', onError);
      });
    } catch (error) {
      if (axios.isCancel(error)) throw new Error('cancelled');
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNREFUSED') {
          throw new Error('Ollama is not running. Start it and try again.');
        }
        if (error.code === 'ETIMEDOUT') {
          throw new Error('Ollama request timed out.');
        }
        // Read Ollama's actual error body (the response is a stream) for a useful message,
        // e.g. "model 'X' not found" or "this model does not support images".
        const detail = await readStreamErrorMessage(error.response?.data);
        const status = error.response?.status;
        // The classic out-of-memory crash (common when a vision model loads its image
        // encoder on a RAM-starved machine). Add an actionable hint instead of the raw text.
        if (/runner has unexpectedly stopped|resource limitation/i.test(detail)) {
          throw new Error(
            'The model ran out of memory and crashed. Free up RAM, switch to a smaller model ' +
              '(e.g. moondream for vision), or use a cloud model in Settings.',
          );
        }
        throw new Error(`Ollama error${status ? ` (${status})` : ''}: ${detail || error.message}`);
      }
      throw error;
    }
  }
}
