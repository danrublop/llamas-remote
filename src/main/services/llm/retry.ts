// Small bounded retry with exponential backoff + jitter for transient cloud-LLM failures.
//
// IMPORTANT: only wrap the *request-establishment* call (the axios.post that opens the SSE
// stream), never the stream read. Once tokens are flowing a failure must not be blindly
// retried — that would replay a half-emitted answer. axios rejects the post on a non-2xx
// status or a connection error *before* the first byte, so wrapping just that call retries
// exactly the pre-first-byte failures and nothing mid-stream.
//
// Retries 429 / 500 / 529 and connection-level errors; honors Retry-After on 429; never
// retries a cancelled request (AbortSignal / axios cancel).

import axios from 'axios';

const RETRYABLE_STATUS = new Set([429, 500, 529]);

/** True if this axios error is a transient failure worth retrying (pre-first-byte only). */
export function isRetryableError(error: unknown): boolean {
  if (axios.isCancel(error)) return false;
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  if (status !== undefined) return RETRYABLE_STATUS.has(status);
  // No response => connection-level failure (ECONNRESET / ETIMEDOUT / ECONNREFUSED / etc.).
  return true;
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms; undefined if unusable. */
export function parseRetryAfterMs(headerValue: unknown): number | undefined {
  if (typeof headerValue !== 'string' || !headerValue.trim()) return undefined;
  const secs = Number(headerValue);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(headerValue);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /** Base backoff in ms (doubles each retry). Default 500. */
  baseDelayMs?: number;
  /** Cap on any single backoff. Default 20000. */
  maxDelayMs?: number;
  /** Aborting stops further retries and cancels between-attempt waits. */
  signal?: AbortSignal;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying transient failures with exponential backoff + full jitter. `fn` must be
 * the request-establishment call only (not the stream read), so a retry never restarts a
 * stream that already emitted tokens.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 20000;
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.signal?.aborted) throw new Error('cancelled');
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isLast = attempt === attempts - 1;
      if (isLast || opts.signal?.aborted || !isRetryableError(error)) throw error;
      // Honor Retry-After on 429; otherwise exponential backoff with full jitter.
      const retryAfter = axios.isAxiosError(error) && error.response?.status === 429
        ? parseRetryAfterMs(error.response?.headers?.['retry-after'])
        : undefined;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const delay = retryAfter ?? Math.random() * backoff;
      await sleep(delay);
    }
  }
  throw lastError;
}
