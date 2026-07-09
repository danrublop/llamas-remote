import { describe, it, expect, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { withRetry, isRetryableError, parseRetryAfterMs } from './retry';

/** Build an AxiosError with an optional HTTP status + headers (mimics a stream response). */
function axiosError(status?: number, headers?: Record<string, string>): AxiosError {
  const err = new AxiosError('boom');
  if (status !== undefined) {
    err.response = {
      status,
      statusText: '',
      data: null,
      headers: new AxiosHeaders(headers),
      config: {} as never,
    };
  }
  return err;
}

const noSleep = () => Promise.resolve();

describe('isRetryableError', () => {
  it('retries 429 / 500 / 529', () => {
    expect(isRetryableError(axiosError(429))).toBe(true);
    expect(isRetryableError(axiosError(500))).toBe(true);
    expect(isRetryableError(axiosError(529))).toBe(true);
  });

  it('does not retry non-transient 4xx', () => {
    expect(isRetryableError(axiosError(400))).toBe(false);
    expect(isRetryableError(axiosError(401))).toBe(false);
    expect(isRetryableError(axiosError(404))).toBe(false);
  });

  it('retries connection-level errors (no response)', () => {
    expect(isRetryableError(axiosError(undefined))).toBe(true);
  });

  it('does not retry plain (non-axios) errors', () => {
    expect(isRetryableError(new Error('nope'))).toBe(false);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('parses an HTTP-date into a future delay', () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(5000);
  });

  it('returns undefined for missing / garbage values', () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
  });
});

describe('withRetry', () => {
  it('returns the first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    expect(await withRetry(fn, { sleep: noSleep })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure then succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(axiosError(529))
      .mockResolvedValue('ok');
    expect(await withRetry(fn, { sleep: noSleep })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after the attempt budget and throws the last error', async () => {
    const fn = vi.fn().mockRejectedValue(axiosError(500));
    await expect(withRetry(fn, { attempts: 3, sleep: noSleep })).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-retryable status', async () => {
    const fn = vi.fn().mockRejectedValue(axiosError(400));
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('honors Retry-After on 429', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn()
      .mockRejectedValueOnce(axiosError(429, { 'retry-after': '3' }))
      .mockResolvedValue('ok');
    await withRetry(fn, { sleep });
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it('does not retry once the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, { signal: controller.signal, sleep: noSleep }))
      .rejects.toThrow('cancelled');
    expect(fn).not.toHaveBeenCalled();
  });

  it('stops retrying if aborted mid-flight rather than restarting', async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.reject(axiosError(500));
    });
    await expect(withRetry(fn, { signal: controller.signal, sleep: noSleep }))
      .rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
