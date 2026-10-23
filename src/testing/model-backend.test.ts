import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelBackendFailure, normalizeModelFailure, runModelBackend,
  type ModelBackend, type ModelBackendFrame, type ModelBackendPolicy } from '../model-backend.js';

const policy: ModelBackendPolicy = { maxAttempts: 2, backoffMs: 10, deadlineMs: 100, maxFrameBytes: 4096 };
const capabilities = { streaming: true, toolObservations: true, nativeSession: true, providerState: true };
const backend = (stream: ModelBackend<string>['stream']): ModelBackend<string> =>
  ({ id: 'fixture', model: 'fixture-model', capabilities, retrySafety: 'model-only', stream });
async function collect(port: ModelBackend<string>, overrides: Partial<ModelBackendPolicy> = {}) {
  const observations = [];
  for await (const event of runModelBackend(port, 'prompt', { policy: { ...policy, ...overrides } })) observations.push(event);
  return observations;
}
afterEach(() => vi.useRealTimers());

describe('bounded model backend contract', () => {
  it('normalizes structured provider errors without exposing provider exception text', () => {
    for (const [status, code] of [[429, 'rate-limited'], [503, 'unavailable'], [401, 'unauthorized'],
      [403, 'unauthorized'], [400, 'provider-failure']] as const) {
      const error = normalizeModelFailure({ status, message: 'private-api-key' });
      expect(error.code).toBe(code);
      expect(error.message).not.toContain('private-api-key');
    }
    expect(normalizeModelFailure({ code: 'ECONNRESET' }).code).toBe('unavailable');
    expect(normalizeModelFailure(new Error('429 private-api-key')).code).toBe('provider-failure');
  });

  it('refuses invalid budgets and unsupported capabilities before invoking a backend', async () => {
    const stream = vi.fn(async function* () { yield { event: { type: 'done' } } as ModelBackendFrame; });
    for (const invalid of [{ maxAttempts: 0 }, { maxAttempts: 1.5 }, { backoffMs: -1 },
      { deadlineMs: Infinity }, { deadlineMs: 2_147_483_648 }, { maxFrameBytes: 0 }])
      await expect(collect(backend(stream), invalid)).rejects.toBeInstanceOf(RangeError);
    const port = { ...backend(stream), capabilities: { ...capabilities, nativeSession: false } };
    const consume = async () => { for await (const _ of runModelBackend(port, '',
      { policy, requiredCapabilities: ['nativeSession'] })) { /* drain */ } };
    await expect(consume()).rejects.toMatchObject({ code: 'unsupported-capability' });
    expect(stream).not.toHaveBeenCalled();
  });

  it('retries only transient model failures within two attempts and ten millisecond backoff', async () => {
    vi.useFakeTimers();
    const stream = vi.fn(async function* () {
      if (stream.mock.calls.length === 1) throw { status: 429 };
      yield { event: { type: 'done', usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.01 } } } as ModelBackendFrame;
    });
    const result = collect(backend(stream));
    await vi.advanceTimersByTimeAsync(9);
    expect(stream).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const observations = await result;
    expect(stream).toHaveBeenCalledTimes(2);
    expect(observations.filter(e => e.type === 'attempt').map(e => [e.attempt, e.outcome]))
      .toEqual([[1, 'started'], [1, 'retrying'], [2, 'started'], [2, 'completed']]);
    expect(observations.find(e => e.type === 'frame')).toMatchObject({
      backendId: 'fixture', model: 'fixture-model', attempt: 2,
      frame: { event: { usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.01 } } },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops at retry exhaustion and never retries permanent provider errors', async () => {
    vi.useFakeTimers();
    const transient = vi.fn(async function* (): AsyncGenerator<ModelBackendFrame> { throw { status: 503 }; });
    const result = expect(collect(backend(transient))).rejects.toMatchObject({ code: 'unavailable' });
    await vi.runAllTimersAsync();
    await result;
    expect(transient).toHaveBeenCalledTimes(2);
    const permanent = vi.fn(async function* (): AsyncGenerator<ModelBackendFrame> { throw { status: 401 }; });
    await expect(collect(backend(permanent))).rejects.toMatchObject({ code: 'unauthorized' });
    expect(permanent).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses malformed oversized and incomplete streams without retrying', async () => {
    for (const event of [{ type: 'tool_call', name: 'lookup' },
      { type: 'tool_result', name: 'lookup', callId: 'c' },
      { type: 'done', usage: { inputTokens: -1 } }, { type: 'unknown' },
      { type: 'delta', text: 'x'.repeat(5000) }]) {
      const stream = vi.fn(async function* () { yield { event } as ModelBackendFrame; });
      await expect(collect(backend(stream))).rejects.toMatchObject({ code: 'invalid-frame' });
      expect(stream).toHaveBeenCalledTimes(1);
    }
    await expect(collect(backend(async function* () { /* no terminal event */ })))
      .rejects.toMatchObject({ code: 'incomplete-stream' });
  });

  it('honors a total deadline even when a provider ignores abort and return', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const close = vi.fn(() => new Promise<IteratorResult<ModelBackendFrame>>(() => {}));
    const port = backend((_input, context) => {
      signal = context.signal;
      return { [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<ModelBackendFrame>>(() => {}), return: close,
      }) };
    });
    const result = expect(collect(port)).rejects.toMatchObject({ code: 'deadline-exceeded' });
    await vi.advanceTimersByTimeAsync(99);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(signal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses one deadline across backoff and stops retrying before the next request', async () => {
    vi.useFakeTimers();
    const stream = vi.fn(async function* (): AsyncGenerator<ModelBackendFrame> { throw new ModelBackendFailure('unavailable'); });
    const result = expect(collect(backend(stream), { backoffMs: 100 })).rejects.toMatchObject({ code: 'deadline-exceeded' });
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(stream).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
