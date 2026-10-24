import { describe, expect, it } from 'vitest';
import { selectSuSessionExecution } from './su-session';

describe('SU execution selection policy (P-002)', () => {
  it.each(['claude', 'codex'] as const)('omitted-headless-policy: defaults only omitted new headless %s sessions to programmatic', (provider) => {
    expect(selectSuSessionExecution({ provider, operation: 'create', headless: true, defaultKind: 'pty' }))
      .toEqual({ ok: true, provider, executionKind: 'programmatic', source: 'headless-default' });
  });

  it.each(['claude', 'codex'] as const)('explicit-selection-precedence: honors explicit %s choices before the headless default', (provider) => {
    for (const kind of ['pty', 'programmatic'] as const) {
      expect(selectSuSessionExecution({ provider, operation: 'create', headless: true, defaultKind: 'pty', requestedKinds: [kind] }))
        .toEqual({ ok: true, provider, executionKind: kind, source: 'explicit' });
    }
  });

  it.each(['claude', 'codex'] as const)('non-headless-default-preservation: retains the configured %s default', (provider) => {
    for (const kind of ['pty', 'programmatic'] as const) {
      expect(selectSuSessionExecution({ provider, operation: 'create', headless: false, defaultKind: kind }))
        .toEqual({ ok: true, provider, executionKind: kind, source: 'client-default' });
    }
  });

  it('provider-execution-cross-product: retains both dimensions with repeated equivalent explicit choices', () => {
    for (const provider of ['claude', 'codex'] as const) {
      for (const kind of ['pty', 'programmatic'] as const) {
        expect(selectSuSessionExecution({ provider, operation: 'create', headless: true,
          defaultKind: 'pty', requestedKinds: [kind, kind], supportedKinds: [kind] }))
          .toEqual({ ok: true, provider, executionKind: kind, source: 'explicit' });
      }
    }
  });

  it.each([[], [''], [undefined], [null], ['sdk'], ['PTY'], ['pty', 'programmatic'], undefined, Array(1)]
    .map((requestedKinds) => ({ requestedKinds })))(
    'refuses present invalid or conflicting input $requestedKinds before any default', ({ requestedKinds }) => {
      const result = selectSuSessionExecution({ provider: 'codex', operation: 'create', headless: true,
        defaultKind: 'pty', requestedKinds });
      expect(result).toMatchObject({ ok: false, refusal: { retryable: false } });
    },
  );

  it('invalid-conflicting-unsupported-refusal: refuses invalid, conflicting and unavailable choices without fallback', () => {
    const create = { provider: 'claude' as const, operation: 'create' as const, headless: true, defaultKind: 'pty' as const,
      supportedKinds: ['pty'] as const };
    expect(selectSuSessionExecution({ ...create, requestedKinds: ['sdk'] }))
      .toMatchObject({ ok: false, refusal: { code: 'invalid_execution_kind', retryable: false } });
    expect(selectSuSessionExecution({ ...create, requestedKinds: ['pty', 'programmatic'] }))
      .toMatchObject({ ok: false, refusal: { code: 'conflicting_execution_kinds', retryable: false } });
    expect(selectSuSessionExecution({ ...create, requestedKinds: ['programmatic'] }))
      .toMatchObject({ ok: false, refusal: { code: 'unsupported_execution_kind' } });
    expect(selectSuSessionExecution(create)).toMatchObject({ ok: false, refusal: { code: 'unsupported_execution_kind' } });
  });

  it('existing-selection-preservation: saved selections take precedence over contrary legacy evidence', () => {
    for (const provider of ['claude', 'codex'] as const) {
      for (const kind of ['pty', 'programmatic'] as const) {
        const otherKind = kind === 'pty' ? 'programmatic' : 'pty';
        expect(selectSuSessionExecution({ provider, operation: 'existing', savedKind: kind, legacyKind: otherKind }))
          .toEqual({ ok: true, provider, executionKind: kind, source: 'saved' });
      }
    }
    expect(selectSuSessionExecution({ provider: 'codex', operation: 'existing', savedKind: '', legacyKind: 'pty' }))
      .toMatchObject({ ok: false, refusal: { code: 'invalid_saved_execution_kind' } });
  });

  it('legacy-selection-evidence: preserves established legacy execution independently of provider', () => {
    for (const provider of ['claude', 'codex'] as const) {
      for (const kind of ['pty', 'programmatic'] as const) {
        expect(selectSuSessionExecution({ provider, operation: 'existing', legacyKind: kind }))
          .toEqual({ ok: true, provider, executionKind: kind, source: 'legacy' });
      }
    }
  });

  it('handoff-required-refusal: refuses both directions of an existing runtime change', () => {
    for (const provider of ['claude', 'codex'] as const) {
      for (const kind of ['pty', 'programmatic'] as const) {
        const otherKind = kind === 'pty' ? 'programmatic' : 'pty';
        expect(selectSuSessionExecution({ provider, operation: 'existing', savedKind: kind,
          requestedKinds: [otherKind] }))
          .toMatchObject({ ok: false, refusal: { code: 'execution_handoff_required', retryable: false } });
      }
    }
  });

  it('preserves the other provider default', () => {
    expect(selectSuSessionExecution({ provider: 'omp', operation: 'create', headless: true, defaultKind: 'pty' }))
      .toEqual({ ok: true, provider: 'omp', executionKind: 'pty', source: 'client-default' });
  });

  it.each([undefined, null, '', 'sdk'])('never infers a legacy execution kind from missing or invalid evidence %s', (legacyKind) => {
    expect(selectSuSessionExecution({ provider: 'claude', operation: 'existing', legacyKind }))
      .toMatchObject({ ok: false, refusal: { code: 'unknown_existing_execution_kind', retryable: false } });
    expect(selectSuSessionExecution({ provider: 'codex', operation: 'existing', legacyKind, requestedKinds: ['programmatic'] }))
      .toMatchObject({ ok: false, refusal: { code: 'unknown_existing_execution_kind' } });
  });
});
