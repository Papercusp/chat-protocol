import { describe, expect, it } from 'vitest';
import {
  VOICE_BRAIN_EMPTY_QUESTION_LINE,
  VOICE_BRAIN_FAILURE_LINE,
  VOICE_BRAIN_TIMEOUT_LINE,
  VOICE_BRAIN_TIMEOUT_MS,
  answerVoiceQuestion,
  voiceQuestionOf,
} from './voice-brain-tool.js';

/** A manual clock: the deadline fires only when a test calls `fire()`. */
function manualTimer() {
  let pending: { fn: () => void; ms: number } | null = null;
  let cleared = false;
  return {
    setTimer: (fn: () => void, ms: number) => {
      pending = { fn, ms };
      return pending;
    },
    clearTimer: () => {
      cleared = true;
    },
    fire: () => pending?.fn(),
    get ms() {
      return pending?.ms;
    },
    get cleared() {
      return cleared;
    },
  };
}

describe('answerVoiceQuestion', () => {
  it('returns the brain answer to speak, trimmed', async () => {
    const clock = manualTimer();
    const result = await answerVoiceQuestion(' what is on my plate ', async (q) => `  You asked: ${q}.  `, clock);
    expect(result).toEqual({ say: 'You asked: what is on my plate.', outcome: 'answered' });
    expect(clock.cleared).toBe(true);
  });

  it('defaults the deadline to VOICE_BRAIN_TIMEOUT_MS', async () => {
    const clock = manualTimer();
    await answerVoiceQuestion('hi', async () => 'hello', clock);
    expect(clock.ms).toBe(VOICE_BRAIN_TIMEOUT_MS);
  });

  it('speaks the timeout line and aborts the brain request at the deadline', async () => {
    const clock = manualTimer();
    let seenSignal: AbortSignal | null = null;
    const pending = answerVoiceQuestion('slow question', (_q, signal) => {
      seenSignal = signal;
      return new Promise<string>(() => { /* never answers */ });
    }, { ...clock, timeoutMs: 1234 });
    expect(clock.ms).toBe(1234);
    clock.fire();
    await expect(pending).resolves.toEqual({ say: VOICE_BRAIN_TIMEOUT_LINE, outcome: 'timeout' });
    expect(seenSignal!.aborted).toBe(true);
  });

  it('speaks the failure line when the brain request throws', async () => {
    const result = await answerVoiceQuestion('q', async () => { throw new Error('502'); }, manualTimer());
    expect(result).toEqual({ say: VOICE_BRAIN_FAILURE_LINE, outcome: 'failed' });
  });

  it('speaks the failure line when the brain answers with nothing', async () => {
    const result = await answerVoiceQuestion('q', async () => '   ', manualTimer());
    expect(result).toEqual({ say: VOICE_BRAIN_FAILURE_LINE, outcome: 'empty-answer' });
  });

  it('never calls the brain for an empty question', async () => {
    let called = false;
    const result = await answerVoiceQuestion('  ', async () => { called = true; return 'x'; }, manualTimer());
    expect(result).toEqual({ say: VOICE_BRAIN_EMPTY_QUESTION_LINE, outcome: 'empty-question' });
    expect(called).toBe(false);
  });

  it('works with the real timers', async () => {
    const result = await answerVoiceQuestion('q', () => new Promise<string>(() => {}), { timeoutMs: 5 });
    expect(result.outcome).toBe('timeout');
  });
});

describe('voiceQuestionOf', () => {
  it('reads `question`, falls back to `text`, and tolerates junk', () => {
    expect(voiceQuestionOf({ question: '  hi  ' })).toBe('hi');
    expect(voiceQuestionOf({ text: 'legacy' })).toBe('legacy');
    expect(voiceQuestionOf({ question: 3 })).toBe('');
    expect(voiceQuestionOf(null)).toBe('');
    expect(voiceQuestionOf('a string')).toBe('');
  });
});
