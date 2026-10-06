import { describe, expect, it } from 'vitest';
import {
  createVoiceTranscriptWriter,
  isSpokenRelayOf,
  normalizeVoiceText,
  VOICE_RELAY_WINDOW_MS,
  type VoiceTranscriptTurn,
} from './voice-transcript.js';

function recorder() {
  const turns: VoiceTranscriptTurn[] = [];
  return { turns, write: (turn: VoiceTranscriptTurn) => { turns.push(turn); } };
}

describe('normalizeVoiceText', () => {
  it('ignores case, punctuation and spacing', () => {
    expect(normalizeVoiceText('  Your meeting is at 3 PM!  ')).toBe('your meeting is at 3 pm');
    expect(normalizeVoiceText('—…')).toBe('');
  });
});

describe('isSpokenRelayOf', () => {
  const answer = 'Your next meeting is with Dana at three, in the Elm room.';

  it('matches the answer spoken verbatim, with different punctuation', () => {
    expect(isSpokenRelayOf('your next meeting is with Dana at three in the Elm room', answer)).toBe(true);
  });

  it('matches the answer wrapped in a lead-in', () => {
    expect(isSpokenRelayOf(`Papercup says: ${answer} Anything else?`, answer)).toBe(true);
  });

  it('matches the answer lightly trimmed', () => {
    expect(isSpokenRelayOf('Your next meeting is with Dana at three', answer)).toBe(true);
  });

  it('does not treat a short acknowledgement inside the answer as a repeat', () => {
    expect(isSpokenRelayOf('Dana', answer)).toBe(false);
    expect(isSpokenRelayOf('Okay.', 'Okay, the file is saved and shared with the whole team now.')).toBe(false);
  });

  it('never matches empty text', () => {
    expect(isSpokenRelayOf('', answer)).toBe(false);
    expect(isSpokenRelayOf('hello', '  ')).toBe(false);
  });
});

describe('createVoiceTranscriptWriter', () => {
  it('writes the user, the front and the brain with their roles and sources, in spoken order', async () => {
    const r = recorder();
    const writer = createVoiceTranscriptWriter({ write: r.write });
    void writer.userSaid('What is on my calendar today?');
    void writer.frontSaid('Let me check with Papercup.');
    await writer.brainAnswered('You have two meetings: standup at nine and a design review at two.');
    expect(r.turns).toEqual([
      { kind: 'user', role: 'user', source: 'voice_stt', text: 'What is on my calendar today?' },
      { kind: 'front', role: 'assistant', source: 'voice_tts', text: 'Let me check with Papercup.' },
      {
        kind: 'brain',
        role: 'assistant',
        source: 'voice_tts',
        text: 'You have two meetings: standup at nine and a design review at two.',
      },
    ]);
  });

  it('skips the front speaking the answer that was already written, once', async () => {
    const r = recorder();
    const writer = createVoiceTranscriptWriter({ write: r.write });
    await writer.brainAnswered('The build is green.');
    await writer.frontSaid('The build is green!');
    await writer.frontSaid('The build is green.');
    expect(r.turns.map((t) => t.kind)).toEqual(['brain', 'front']);
  });

  it('writes front replies that are not a repeat of the answer', async () => {
    const r = recorder();
    const writer = createVoiceTranscriptWriter({ write: r.write });
    await writer.brainAnswered('The build is green.');
    await writer.frontSaid('Sure, happy to help.');
    expect(r.turns.map((t) => t.text)).toEqual(['The build is green.', 'Sure, happy to help.']);
  });

  it('suppresses the relay of an answer written elsewhere without writing it', async () => {
    const r = recorder();
    const writer = createVoiceTranscriptWriter({ write: r.write });
    writer.noteBrainAnswer('Your invoice was sent this morning.');
    await writer.frontSaid('Your invoice was sent this morning.');
    expect(r.turns).toEqual([]);
  });

  it('stops suppressing a relay once the window has passed', async () => {
    const r = recorder();
    let clock = 1_000;
    const writer = createVoiceTranscriptWriter({ write: r.write, now: () => clock });
    writer.noteBrainAnswer('Lunch is at noon.');
    clock += VOICE_RELAY_WINDOW_MS + 1;
    await writer.frontSaid('Lunch is at noon.');
    expect(r.turns.map((t) => t.kind)).toEqual(['front']);
  });

  it('ignores empty and whitespace-only text', async () => {
    const r = recorder();
    const writer = createVoiceTranscriptWriter({ write: r.write });
    await writer.userSaid('   ');
    await writer.frontSaid('');
    await writer.brainAnswered('\n');
    writer.noteBrainAnswer(' ');
    expect(r.turns).toEqual([]);
  });

  it('keeps spoken order when an earlier write is slow', async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const writer = createVoiceTranscriptWriter({
      write: async (turn) => {
        if (turn.kind === 'user') await firstDone;
        order.push(turn.kind);
      },
    });
    const userWrite = writer.userSaid('Hello?');
    const frontWrite = writer.frontSaid('Hi there.');
    releaseFirst();
    await Promise.all([userWrite, frontWrite]);
    expect(order).toEqual(['user', 'front']);
  });

  it('reports a failed write and still writes the turns after it', async () => {
    const written: string[] = [];
    const failures: string[] = [];
    const writer = createVoiceTranscriptWriter({
      write: (turn) => {
        if (turn.kind === 'user') throw new Error('store down');
        written.push(turn.text);
      },
      onWriteError: (error, turn) => failures.push(`${turn.kind}:${(error as Error).message}`),
    });
    void writer.userSaid('Are you there?');
    await writer.frontSaid('I am here.');
    expect(failures).toEqual(['user:store down']);
    expect(written).toEqual(['I am here.']);
  });
});
