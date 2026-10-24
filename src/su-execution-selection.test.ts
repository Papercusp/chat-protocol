import { describe, expect, it } from 'vitest';
import { selectSuSessionExecution } from './su-session';

describe('SU execution selection policy (P-002)', () => {
  it.each(['claude', 'codex'] as const)('defaults only omitted new headless %s sessions to programmatic', (provider) => {
    expect(selectSuSessionExecution({ provider, operation: 'create', headless: true, defaultKind: 'pty' }))
      .toEqual({ ok: true, provider, executionKind: 'programmatic', source: 'headless-default' });
    for (const kind of ['pty', 'programmatic'] as const) {
      expect(selectSuSessionExecution({ provider, operation: 'create', headless: true, defaultKind: 'pty', requestedKinds: [kind] }))
        .toEqual({ ok: true, provider, executionKind: kind, source: 'explicit' });
      expect(selectSuSessionExecution({ provider, operation: 'create', headless: false, defaultKind: kind }))
        .toEqual({ ok: true, provider, executionKind: kind, source: 'client-default' });
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

  it('refuses an unavailable explicit choice or unavailable headless default instead of falling back', () => {
    const create = { provider: 'claude' as const, operation: 'create' as const, headless: true, defaultKind: 'pty' as const,
      supportedKinds: ['pty'] as const };
    expect(selectSuSessionExecution({ ...create, requestedKinds: ['programmatic'] }))
      .toMatchObject({ ok: false, refusal: { code: 'unsupported_execution_kind' } });
    expect(selectSuSessionExecution(create)).toMatchObject({ ok: false, refusal: { code: 'unsupported_execution_kind' } });
  });

  it('keeps saved selections and known legacy execution independent of provider', () => {
    for (const provider of ['claude', 'codex'] as const) {
      for (const kind of ['pty', 'programmatic'] as const) {
        expect(selectSuSessionExecution({ provider, operation: 'existing', savedKind: kind, legacyKind: 'pty' }))
          .toEqual({ ok: true, provider, executionKind: kind, source: 'saved' });
        expect(selectSuSessionExecution({ provider, operation: 'existing', legacyKind: kind }))
          .toEqual({ ok: true, provider, executionKind: kind, source: 'legacy' });
      }
    }
    expect(selectSuSessionExecution({ provider: 'codex', operation: 'existing', savedKind: 'pty', legacyKind: 'pty', requestedKinds: ['programmatic'] }))
      .toMatchObject({ ok: false, refusal: { code: 'execution_handoff_required' } });
    expect(selectSuSessionExecution({ provider: 'codex', operation: 'existing', savedKind: '', legacyKind: 'pty' }))
      .toMatchObject({ ok: false, refusal: { code: 'invalid_saved_execution_kind' } });
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
