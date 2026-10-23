import { parseChatEventV1, type ChatEventV1 } from './protocol-v1.js';

/** A transport boundary, not a tool executor. Host adapters retain their SDK,
 * native session, credentials, permission checks and budget policy. */
export interface ModelBackendCapabilities {
  streaming: boolean;
  toolObservations: boolean;
  nativeSession: boolean;
  providerState: boolean;
}
export type ModelBackendEvent = Extract<ChatEventV1,
  { type: 'delta' | 'tool_call' | 'tool_result' | 'provenance' | 'session' | 'done' | 'error' }>;
export interface ModelBackendFrame {
  event: ModelBackendEvent;
  /** Opaque JSON needed by the provider; hosts round-trip it without reinterpretation. */
  providerState?: unknown;
}
export interface ModelBackend<TInput> {
  id: string;
  model: string;
  capabilities: ModelBackendCapabilities;
  /** Native agents may execute tools before an observation reaches this stream.
   * Such requests MUST NOT be restarted by the model-only retry wrapper. */
  retrySafety: 'model-only' | 'effects-possible';
  stream(input: TInput, context: { signal: AbortSignal; attempt: number }): AsyncIterable<ModelBackendFrame>;
}
export type ModelFailureCode = 'rate-limited' | 'unavailable' | 'provider-failure'
  | 'unauthorized' | 'aborted' | 'deadline-exceeded' | 'invalid-frame'
  | 'unsupported-capability' | 'incomplete-stream';
export type ModelUsage = NonNullable<Extract<ModelBackendEvent, { type: 'done' }>['usage']>;
const messages: Record<ModelFailureCode, string> = {
  'rate-limited': 'The model request was rate limited.',
  unavailable: 'The model service is unavailable.',
  'provider-failure': 'The model request failed.',
  unauthorized: 'The model request was not authorized.',
  aborted: 'The model request was cancelled.',
  'deadline-exceeded': 'The model request exceeded its deadline.',
  'invalid-frame': 'The model returned an invalid frame.',
  'unsupported-capability': 'The selected backend does not support the required capability.',
  'incomplete-stream': 'The model stream ended without a terminal result.',
};
export class ModelBackendFailure extends Error {
  constructor(readonly code: ModelFailureCode, readonly usage?: ModelUsage) {
    super(messages[code]);
    this.name = 'ModelBackendFailure';
  }
}
export interface ModelBackendPolicy {
  maxAttempts: number;
  backoffMs: number;
  /** One total deadline, including retries, backoff and consumer backpressure. */
  deadlineMs: number;
  maxFrameBytes: number;
}
export interface RunModelBackendOptions {
  policy: ModelBackendPolicy;
  signal?: AbortSignal;
  requiredCapabilities?: readonly (keyof ModelBackendCapabilities)[];
}
type Observation = { backendId: string; model: string; attempt: number };
export type ModelBackendObservation = Observation & (
  | { type: 'frame'; frame: ModelBackendFrame }
  | { type: 'attempt'; outcome: 'started' | 'retrying' | 'completed' | 'failed'; failure?: ModelFailureCode; usage?: ModelUsage }
);

/** Normalize structured status/code only. Provider exception text can contain
 * credentials or internal payloads and never becomes a public error message. */
export function normalizeModelFailure(error: unknown): ModelBackendFailure {
  if (error instanceof ModelBackendFailure) return error;
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    const parsed = e.usage === undefined ? undefined : parseChatEventV1({ type: 'done', usage: e.usage });
    if (e.usage !== undefined && (!parsed || parsed.type !== 'done'))
      return new ModelBackendFailure('invalid-frame');
    const usage = parsed?.type === 'done' ? parsed.usage : undefined;
    const status = Number(e.status ?? e.statusCode);
    if (status === 401 || status === 403) return new ModelBackendFailure('unauthorized', usage);
    if (status === 429) return new ModelBackendFailure('rate-limited', usage);
    if (status === 408 || (status >= 500 && status <= 599)
      || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].includes(String(e.code)))
      return new ModelBackendFailure('unavailable', usage);
    if (e.name === 'AbortError') return new ModelBackendFailure('aborted', usage);
    return new ModelBackendFailure('provider-failure', usage);
  }
  return new ModelBackendFailure('provider-failure');
}
const capabilityKeys = ['streaming', 'toolObservations', 'nativeSession', 'providerState'] as const;
const eventTypes = new Set(['delta', 'tool_call', 'tool_result', 'provenance', 'session', 'done', 'error']);
const identifier = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 512 && value.trim() === value;

function validatePolicy(policy: ModelBackendPolicy): void {
  for (const name of ['maxAttempts', 'deadlineMs', 'maxFrameBytes'] as const)
    if (!Number.isSafeInteger(policy[name]) || policy[name] < 1) throw new RangeError(`Invalid ${name}`);
  if (!Number.isSafeInteger(policy.backoffMs) || policy.backoffMs < 0) throw new RangeError('Invalid backoffMs');
  if (policy.deadlineMs > 2_147_483_647 || policy.backoffMs > 2_147_483_647)
    throw new RangeError('Timer policy exceeds the supported range');
}
function parseFrame(raw: unknown, caps: ModelBackendCapabilities, maxBytes: number): ModelBackendFrame {
  if (!raw || typeof raw !== 'object') throw new ModelBackendFailure('invalid-frame');
  let snapshot: { event?: unknown; providerState?: unknown };
  try {
    const json = JSON.stringify(raw);
    if (new TextEncoder().encode(json).length > maxBytes) throw new Error('frame limit');
    snapshot = JSON.parse(json);
  } catch { throw new ModelBackendFailure('invalid-frame'); }
  const event = parseChatEventV1(snapshot.event);
  if (!event || !eventTypes.has(event.type)) throw new ModelBackendFailure('invalid-frame');
  if ((event.type === 'delta' && !caps.streaming)
    || (event.type === 'session' && !caps.nativeSession)
    || ((event.type === 'tool_call' || event.type === 'tool_result') && !caps.toolObservations)
    || (Object.hasOwn(snapshot, 'providerState') && !caps.providerState))
    throw new ModelBackendFailure('unsupported-capability');
  return { event: event as ModelBackendEvent,
    ...(Object.hasOwn(snapshot, 'providerState') ? { providerState: snapshot.providerState } : {}) };
}
function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof ModelBackendFailure
    ? signal.reason : new ModelBackendFailure('aborted');
}
/** Race a provider that ignores cancellation; remove each listener on settlement. */
function bounded<T>(operation: () => PromiseLike<T> | T, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof ModelBackendFailure
      ? signal.reason : new ModelBackendFailure('aborted'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(operation).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
async function backoff(milliseconds: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await bounded(() => new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds); }), signal); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Pull exactly one frame at a time: no background pump or unbounded event queue.
 * A model-only transient request may retry only before publishing any model frame.
 * Effects-possible backends never retry here, even if they fail before observation. */
export async function* runModelBackend<TInput>(backend: ModelBackend<TInput>, input: TInput,
  options: RunModelBackendOptions): AsyncGenerator<ModelBackendObservation, void, void> {
  const policy = { ...options.policy };
  validatePolicy(policy);
  if (!identifier(backend.id) || !identifier(backend.model)
    || !backend.capabilities || capabilityKeys.some(key => typeof backend.capabilities[key] !== 'boolean')
    || !['model-only', 'effects-possible'].includes(backend.retrySafety))
    throw new ModelBackendFailure('unsupported-capability');
  const caps = { ...backend.capabilities };
  const retrySafety = backend.retrySafety;
  const backendId = backend.id;
  const model = backend.model;
  const stream = backend.stream.bind(backend);
  if ((options.requiredCapabilities ?? []).some(key => !capabilityKeys.includes(key) || !caps[key]))
    throw new ModelBackendFailure('unsupported-capability');
  const control = new AbortController();
  const abort = () => control.abort(new ModelBackendFailure('aborted'));
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => control.abort(new ModelBackendFailure('deadline-exceeded')), policy.deadlineMs);
  try {
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      checkAbort(control.signal);
      const observation = { backendId, model, attempt };
      yield { ...observation, type: 'attempt', outcome: 'started' };
      const child = new AbortController();
      const cancelChild = () => child.abort(control.signal.reason);
      control.signal.addEventListener('abort', cancelChild, { once: true });
      let iterator: AsyncIterator<ModelBackendFrame> | undefined;
      let published = false;
      let failure: ModelBackendFailure | undefined;
      let complete = false;
      try {
        checkAbort(control.signal);
        iterator = stream(input, { signal: child.signal, attempt })[Symbol.asyncIterator]();
        while (true) {
          const step = await bounded(() => iterator!.next(), control.signal);
          if (step.done) throw new ModelBackendFailure('incomplete-stream');
          const frame = parseFrame(step.value, caps, policy.maxFrameBytes);
          if (frame.event.type === 'error') throw new ModelBackendFailure(
            frame.event.code === 'deadline-exceeded' ? 'deadline-exceeded' : 'provider-failure');
          published = true;
          complete = frame.event.type === 'done';
          yield { ...observation, type: 'frame', frame };
          if (complete) break;
        }
      } catch (error) { failure = normalizeModelFailure(error); }
      finally {
        child.abort(new ModelBackendFailure('aborted'));
        control.signal.removeEventListener('abort', cancelChild);
        // A stuck provider's return() cannot delay the cancellation result.
        try { void Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* cancellation is already signalled */ }
      }
      if (complete) { yield { ...observation, type: 'attempt', outcome: 'completed' }; return; }
      failure ??= new ModelBackendFailure('provider-failure');
      const retry = retrySafety === 'model-only' && !published && attempt < policy.maxAttempts
        && ['rate-limited', 'unavailable'].includes(failure.code) && !control.signal.aborted;
      yield { ...observation, type: 'attempt', outcome: retry ? 'retrying' : 'failed', failure: failure.code,
        ...(failure.usage === undefined ? {} : { usage: { ...failure.usage } }) };
      if (!retry) throw failure;
      await backoff(policy.backoffMs, control.signal);
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    control.abort(new ModelBackendFailure('aborted'));
  }
}
