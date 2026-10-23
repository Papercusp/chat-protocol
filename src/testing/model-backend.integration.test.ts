import { afterEach, describe, expect, it, vi } from 'vitest';
import { runModelBackend, type ModelBackend, type ModelBackendFrame,
  type ModelBackendObservation } from '../model-backend.js';

const policy = { maxAttempts: 2, backoffMs: 10, deadlineMs: 100, maxFrameBytes: 4096 };
const capabilities = { streaming: true, toolObservations: true, nativeSession: true, providerState: true };
function port(stream: ModelBackend<object>['stream'], retrySafety: ModelBackend<object>['retrySafety'] = 'model-only') {
  return { id: 'existing-host', model: 'existing-model', capabilities, retrySafety, stream };
}
async function drain(backend: ModelBackend<object>, observations: ModelBackendObservation[] = [], signal?: AbortSignal) {
  for await (const observation of runModelBackend(backend, {}, { policy, signal })) observations.push(observation);
  return observations;
}
afterEach(() => vi.useRealTimers());

describe('model backend host adapter composition (tree only)', () => {
  it('preserves native session provider state tool pairs usage and provenance without executing tools', async () => {
    const request = { nativeResume: 'native-42', providerMetadata: { opaque: 'signature' } };
    const stream = vi.fn(async function* (input: object) {
      expect(input).toBe(request);
      for (const frame of [
        { event: { type: 'session', sessionId: 'native-42' } },
        { event: { type: 'provenance', engine: 'native-cli', model: 'resolved-model', accountRoute: 'host-selected' } },
        { event: { type: 'tool_call', name: 'host:lookup', callId: 'c1', input: { ref: 'r' } }, providerState: { opaque: 'signature' } },
        { event: { type: 'tool_result', name: 'host:lookup', callId: 'c1', ok: true } },
        { event: { type: 'delta', text: 'done' } },
        { event: { type: 'done', usage: { inputTokens: 4, outputTokens: 1, costUsd: 0.01 } } },
      ]) yield frame as ModelBackendFrame;
    });
    const observations = [];
    for await (const e of runModelBackend(port(stream, 'effects-possible'), request,
      { policy, requiredCapabilities: ['nativeSession', 'providerState', 'toolObservations'] })) observations.push(e);
    const frames = observations.flatMap(e => e.type === 'frame' ? [e.frame] : []);
    expect(frames.map(f => f.event.type)).toEqual(['session', 'provenance', 'tool_call', 'tool_result', 'delta', 'done']);
    expect(frames[1].event).toMatchObject({ engine: 'native-cli', model: 'resolved-model', accountRoute: 'host-selected' });
    expect(frames[2].providerState).toEqual({ opaque: 'signature' });
    expect(frames[5].event).toMatchObject({ usage: { inputTokens: 4, outputTokens: 1, costUsd: 0.01 } });
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('never restarts after partial output or a tool boundary', async () => {
    for (const event of [{ type: 'delta', text: 'partial' },
      { type: 'tool_call', name: 'host:effect', callId: 'c1' }]) {
      let effects = 0;
      const observations: ModelBackendObservation[] = [];
      const stream = vi.fn(async function* () {
        effects++;
        yield { event } as ModelBackendFrame;
        throw { status: 503 };
      });
      await expect(drain(port(stream), observations)).rejects.toMatchObject({ code: 'unavailable' });
      expect(stream).toHaveBeenCalledTimes(1);
      expect(effects).toBe(1);
      expect(observations.filter(e => e.type === 'frame')).toHaveLength(1);
      expect(observations.at(-1)).toMatchObject({ type: 'attempt', outcome: 'failed', failure: 'unavailable' });
    }
  });

  it('never retries an effects-possible native backend even before the first observed tool event', async () => {
    let effects = 0;
    const stream = vi.fn(async function* (): AsyncGenerator<ModelBackendFrame> { effects++; throw { status: 503 }; });
    await expect(drain(port(stream, 'effects-possible'))).rejects.toMatchObject({ code: 'unavailable' });
    expect(stream).toHaveBeenCalledTimes(1);
    expect(effects).toBe(1);
  });

  it('snapshots retry safety and provenance before an adapter can mutate its descriptor', async () => {
    let effects = 0;
    const backend = port(async function* (): AsyncGenerator<ModelBackendFrame> {
      effects++;
      backend.retrySafety = 'model-only';
      backend.id = 'replacement';
      backend.model = 'replacement-model';
      throw { status: 503 };
    }, 'effects-possible');
    const observations: ModelBackendObservation[] = [];
    await expect(drain(backend, observations)).rejects.toMatchObject({ code: 'unavailable' });
    expect(effects).toBe(1);
    expect(observations.every(e => e.backendId === 'existing-host' && e.model === 'existing-model')).toBe(true);
  });

  it('retains measured failure usage and keeps unreported usage unknown', async () => {
    for (const usage of [undefined, { inputTokens: 7, outputTokens: 2, costUsd: 0.01 }]) {
      const observations: ModelBackendObservation[] = [];
      const backend = port(async function* (): AsyncGenerator<ModelBackendFrame> { throw { status: 401, usage }; });
      await expect(drain(backend, observations)).rejects.toMatchObject({ code: 'unauthorized' });
      const receipt = observations.at(-1);
      expect(receipt).toMatchObject({ type: 'attempt', outcome: 'failed' });
      if (usage === undefined) expect(receipt).not.toHaveProperty('usage');
      else expect(receipt).toHaveProperty('usage', usage);
    }
  });

  it('propagates disconnect abort and calls iterator cleanup without buffering future frames', async () => {
    const controller = new AbortController();
    let childSignal: AbortSignal | undefined;
    let produced = 0;
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    const backend = port((_input, context) => {
      childSignal = context.signal;
      return { [Symbol.asyncIterator]: () => ({ next: async () => {
        produced++;
        return { done: false as const, value: { event: { type: 'delta' as const, text: 'one' } } };
      }, return: close }) };
    });
    const iterator = runModelBackend(backend, {}, { policy, signal: controller.signal });
    expect((await iterator.next()).value).toMatchObject({ type: 'attempt', outcome: 'started' });
    expect(produced).toBe(0);
    expect((await iterator.next()).value).toMatchObject({ type: 'frame' });
    expect(produced).toBe(1);
    controller.abort();
    expect(childSignal?.aborted).toBe(true);
    expect((await iterator.next()).value).toMatchObject({ type: 'attempt', outcome: 'failed', failure: 'aborted' });
    await expect(iterator.next()).rejects.toMatchObject({ code: 'aborted' });
    expect(produced).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('consumer return aborts the actual host stream and settles its cleanup', async () => {
    let signal: AbortSignal | undefined;
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    const backend = port((_input, context) => {
      signal = context.signal;
      return { [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false as const, value: { event: { type: 'delta' as const, text: 'one' } } }),
        return: close,
      }) };
    });
    const iterator = runModelBackend(backend, {}, { policy });
    await iterator.next(); await iterator.next();
    await iterator.return();
    expect(signal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
