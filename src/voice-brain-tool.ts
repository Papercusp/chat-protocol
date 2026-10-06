/**
 * The `ask_papercup` voice tool contract, shared by the desktop and the portal.
 *
 * Two-tier voice (plan voice-two-tier-elevenlabs-agent-2026-10-06, P-003): a
 * fast ElevenLabs agent talks with the user and hands anything substantive to
 * Papercup through the `ask_papercup` client tool. ElevenLabs speaks a short
 * holding line while the tool runs (the tool's `pre_tool_speech: "force"`), so
 * the tool itself only has to return Papercup's answer as text to say.
 *
 * Papercup takes ~16 s to its first word today (plan D-004), so the tool runs
 * the brain under a deadline. A brain that is late or fails never leaves the
 * caller in silence: the tool always returns a short line the agent can speak.
 *
 * Pure and dependency-free. Each client injects how it reaches Papercup.
 */

export const ASK_PAPERCUP_TOOL_NAME = 'ask_papercup';

/**
 * How long the client waits for Papercup's answer. The ElevenLabs tool's own
 * `response_timeout_secs` must be longer than this, so the client — not
 * ElevenLabs — decides what the user hears when Papercup is late.
 */
export const VOICE_BRAIN_TIMEOUT_MS = 40_000;

/** Spoken when Papercup has not answered within the deadline. */
export const VOICE_BRAIN_TIMEOUT_LINE =
  "Papercup is taking longer than usual, so I've stopped waiting. Please ask again in a moment.";

/** Spoken when Papercup could not be reached or its answer failed. */
export const VOICE_BRAIN_FAILURE_LINE = "I couldn't reach Papercup just then. Please try again.";

/** Spoken when the tool was called with nothing to ask. */
export const VOICE_BRAIN_EMPTY_QUESTION_LINE = "Sorry, I didn't catch the question. Could you say it again?";

export type VoiceBrainOutcome = 'answered' | 'timeout' | 'failed' | 'empty-question' | 'empty-answer';

export interface VoiceBrainResult {
  /** What the voice agent should say. Never empty. */
  say: string;
  outcome: VoiceBrainOutcome;
}

export interface AnswerVoiceQuestionOptions {
  timeoutMs?: number;
  /** Injected for tests; defaults to the global timers. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Reads the question from the tool's parameters (`question`, or a legacy `text`). */
export function voiceQuestionOf(parameters: unknown): string {
  if (!parameters || typeof parameters !== 'object') return '';
  const p = parameters as { question?: unknown; text?: unknown };
  const raw = typeof p.question === 'string' ? p.question : typeof p.text === 'string' ? p.text : '';
  return raw.trim();
}

/**
 * Ask Papercup and return what to say.
 *
 * `ask` receives an AbortSignal that fires at the deadline, so the caller can
 * cancel the brain request it started instead of leaving it running unheard.
 */
export async function answerVoiceQuestion(
  question: string,
  ask: (question: string, signal: AbortSignal) => Promise<string>,
  options: AnswerVoiceQuestionOptions = {},
): Promise<VoiceBrainResult> {
  const q = question.trim();
  if (!q) return { say: VOICE_BRAIN_EMPTY_QUESTION_LINE, outcome: 'empty-question' };

  const timeoutMs = options.timeoutMs ?? VOICE_BRAIN_TIMEOUT_MS;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const controller = new AbortController();

  let timer: unknown;
  const deadline = new Promise<VoiceBrainResult>((resolve) => {
    timer = setTimer(() => {
      controller.abort();
      resolve({ say: VOICE_BRAIN_TIMEOUT_LINE, outcome: 'timeout' });
    }, timeoutMs);
  });

  const answer = (async (): Promise<VoiceBrainResult> => {
    try {
      const text = (await ask(q, controller.signal)).trim();
      if (!text) return { say: VOICE_BRAIN_FAILURE_LINE, outcome: 'empty-answer' };
      return { say: text, outcome: 'answered' };
    } catch {
      return { say: VOICE_BRAIN_FAILURE_LINE, outcome: 'failed' };
    }
  })();

  try {
    return await Promise.race([answer, deadline]);
  } finally {
    clearTimer(timer);
  }
}
