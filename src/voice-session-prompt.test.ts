import { describe, expect, it } from 'vitest';
import {
  buildVoiceSessionPrompt,
  VOICE_SESSION_CONTEXT_HEADING,
  type VoiceSessionTurn,
} from './voice-session-prompt.js';

const BASE = 'You are the voice of Papercup.';
const SCOPE = 'ws-a';
const identity = (t: string) => t;
const redactKeys = (t: string) => t.replace(/sk_[A-Za-z0-9]{8,}/g, '[REDACTED]');

function turn(role: VoiceSessionTurn['role'], text: string, scopeId = SCOPE): VoiceSessionTurn {
  return { role, text, scopeId };
}

describe('buildVoiceSessionPrompt', () => {
  it('returns the base prompt alone when there is no conversation and no name', () => {
    expect(buildVoiceSessionPrompt({ basePrompt: BASE, scopeId: SCOPE, turns: [], redact: identity })).toBe(BASE);
  });

  it('adds the user name and the recent turns in chronological order after the base prompt', () => {
    const prompt = buildVoiceSessionPrompt({
      basePrompt: BASE,
      scopeId: SCOPE,
      userName: 'Avi',
      turns: [turn('user', 'What is on my calendar?'), turn('assistant', 'Two meetings today.')],
      redact: identity,
    });
    expect(prompt).toBe(
      [
        BASE,
        "The user's name is Avi.",
        `${VOICE_SESSION_CONTEXT_HEADING}\nUser: What is on my calendar?\nPapercup: Two meetings today.`,
      ].join('\n\n'),
    );
  });

  it('runs every turn through the redactor before it reaches the prompt', () => {
    const prompt = buildVoiceSessionPrompt({
      basePrompt: BASE,
      scopeId: SCOPE,
      turns: [turn('user', 'my key is sk_abcdef1234567890 keep it'), turn('assistant', 'Stored sk_ZZZZZZZZZZZZ.')],
      redact: redactKeys,
    });
    expect(prompt).not.toMatch(/sk_[A-Za-z0-9]{8,}/);
    expect(prompt).toContain('User: my key is [REDACTED] keep it');
    expect(prompt).toContain('Papercup: Stored [REDACTED].');
  });

  it('drops turns from any other scope even when they are the newest', () => {
    const prompt = buildVoiceSessionPrompt({
      basePrompt: BASE,
      scopeId: SCOPE,
      turns: [turn('user', 'mine'), turn('assistant', 'other workspace secret plan', 'ws-b')],
      redact: identity,
    });
    expect(prompt).toContain('User: mine');
    expect(prompt).not.toContain('other workspace');
  });

  it('keeps the newest turns within the turn cap and the character budget', () => {
    const turns = Array.from({ length: 30 }, (_, i) => turn(i % 2 ? 'assistant' : 'user', `message ${i}`));
    const capped = buildVoiceSessionPrompt({ basePrompt: BASE, scopeId: SCOPE, turns, redact: identity, maxTurns: 3 });
    expect(capped.split('\n').filter((l) => /^(User|Papercup): /.test(l))).toEqual([
      'Papercup: message 27',
      'User: message 28',
      'Papercup: message 29',
    ]);

    const budget = buildVoiceSessionPrompt({ basePrompt: BASE, scopeId: SCOPE, turns, redact: identity, maxContextChars: 40 });
    const lines = budget.split('\n').filter((l) => /^(User|Papercup): /.test(l));
    expect(lines.at(-1)).toBe('Papercup: message 29');
    expect(lines.join('\n').length).toBeLessThanOrEqual(40);
  });

  it('flattens whitespace, cuts long turns, and skips turns that redact to nothing', () => {
    const prompt = buildVoiceSessionPrompt({
      basePrompt: BASE,
      scopeId: SCOPE,
      turns: [turn('user', 'line one\n\nline   two'), turn('assistant', 'x'.repeat(50)), turn('user', '   ')],
      redact: identity,
      maxTurnChars: 10,
    });
    expect(prompt).toContain('User: line one…');
    expect(prompt).toContain(`Papercup: ${'x'.repeat(9)}…`);
    expect(prompt.split('\n').filter((l) => l.startsWith('User: '))).toHaveLength(1);
  });
});
