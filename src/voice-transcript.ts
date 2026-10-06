/**
 * Writing a two-tier voice session into the Papercup conversation.
 *
 * Two-tier voice (plan voice-two-tier-elevenlabs-agent-2026-10-06, P-005,
 * decision D-008): a fast ElevenLabs agent (the "front") talks with the user
 * and hands substantive questions to Papercup (the "brain") through the
 * `ask_papercup` tool. Text chat reads the same conversation, so every voice
 * turn has to land there exactly once:
 *
 *   - what the user said            → role 'user',      source 'voice_stt'
 *   - what the front agent said     → role 'assistant', source 'voice_tts'
 *   - Papercup's answer             → role 'assistant', source 'voice_tts'
 *
 * The front usually speaks Papercup's answer aloud after the tool returns. That
 * spoken relay is the same message as the answer already written, so it is
 * skipped. The front's paraphrase of the question it passed to `ask_papercup`
 * is never written: the user's own words are the user turn.
 *
 * Writes are serialized, so turns land in the order they were spoken even when
 * an earlier write is slow. A failed write never blocks later ones.
 *
 * Pure and dependency-free. Each client injects how a turn is stored.
 */

export type VoiceTranscriptKind = 'user' | 'front' | 'brain';

export interface VoiceTranscriptTurn {
  kind: VoiceTranscriptKind;
  role: 'user' | 'assistant';
  source: 'voice_stt' | 'voice_tts';
  text: string;
}

/**
 * How long a written answer suppresses the front's spoken repeat of it. The
 * relay normally follows the tool result within seconds; the window only
 * bounds how long a stale answer can swallow an unrelated reply.
 */
export const VOICE_RELAY_WINDOW_MS = 120_000;

export interface VoiceTranscriptWriterOptions {
  write(turn: VoiceTranscriptTurn): Promise<void> | void;
  onWriteError?: (error: unknown, turn: VoiceTranscriptTurn) => void;
  now?: () => number;
  relayWindowMs?: number;
}

export interface VoiceTranscriptWriter {
  /** A final user transcript from the voice session. */
  userSaid(text: string): Promise<void>;
  /** Text the front agent spoke. Skipped when it repeats an answer already written. */
  frontSaid(text: string): Promise<void>;
  /** Papercup answered: write the answer and expect the front to repeat it. */
  brainAnswered(text: string): Promise<void>;
  /**
   * Papercup answered and something else already wrote the answer (the portal
   * host writes it server-side): only expect the front to repeat it.
   */
  noteBrainAnswer(text: string): void;
}

/** Lower-case words and digits only, so punctuation and spacing never decide a match. */
export function normalizeVoiceText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Whether `spoken` is the front agent repeating `answer`: the same words, the
 * answer with a lead-in or tail around it, or the answer lightly trimmed. A
 * short reply that merely appears inside a long answer ("okay") is not a
 * repeat.
 */
export function isSpokenRelayOf(spoken: string, answer: string): boolean {
  const s = normalizeVoiceText(spoken);
  const a = normalizeVoiceText(answer);
  if (!s || !a) return false;
  if (s === a || s.includes(a)) return true;
  return a.includes(s) && s.length * 2 >= a.length;
}

export function createVoiceTranscriptWriter(options: VoiceTranscriptWriterOptions): VoiceTranscriptWriter {
  const now = options.now ?? Date.now;
  const relayWindowMs = options.relayWindowMs ?? VOICE_RELAY_WINDOW_MS;
  const pendingAnswers: Array<{ text: string; at: number }> = [];
  let queue: Promise<void> = Promise.resolve();

  function enqueue(turn: VoiceTranscriptTurn): Promise<void> {
    queue = queue.then(async () => {
      try {
        await options.write(turn);
      } catch (error) {
        options.onWriteError?.(error, turn);
      }
    });
    return queue;
  }

  function expectRelay(text: string): void {
    pendingAnswers.push({ text, at: now() });
  }

  /** Consumes the pending answer this reply repeats, if any. */
  function consumeRelay(spoken: string): boolean {
    const cutoff = now() - relayWindowMs;
    for (let i = pendingAnswers.length - 1; i >= 0; i -= 1) {
      if (pendingAnswers[i]!.at < cutoff) pendingAnswers.splice(i, 1);
    }
    const match = pendingAnswers.findIndex((answer) => isSpokenRelayOf(spoken, answer.text));
    if (match === -1) return false;
    pendingAnswers.splice(match, 1);
    return true;
  }

  return {
    userSaid(text) {
      const trimmed = text.trim();
      if (!trimmed) return queue;
      return enqueue({ kind: 'user', role: 'user', source: 'voice_stt', text: trimmed });
    },
    frontSaid(text) {
      const trimmed = text.trim();
      if (!trimmed || consumeRelay(trimmed)) return queue;
      return enqueue({ kind: 'front', role: 'assistant', source: 'voice_tts', text: trimmed });
    },
    brainAnswered(text) {
      const trimmed = text.trim();
      if (!trimmed) return queue;
      expectRelay(trimmed);
      return enqueue({ kind: 'brain', role: 'assistant', source: 'voice_tts', text: trimmed });
    },
    noteBrainAnswer(text) {
      const trimmed = text.trim();
      if (trimmed) expectRelay(trimmed);
    },
  };
}
