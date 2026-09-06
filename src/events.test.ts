import { describe, expect, it } from 'vitest';
import {
  EVENT_CHANNEL_TYPES,
  isChatEventType,
  parseChatEvent,
  type ChatEvent,
  type ChatTurn,
  type ChatTurnsPage,
} from './index';

// papercup-chat-one-component-one-contract D-008: the protocol's vocabulary IS
// the measured wire. These fixtures are the exact `event:` names + `data:` bodies
// the two papercusp backends emit today (operator:converse, the agent-loop chat
// engine) — P-011's render matrix reuses them.

describe('parseChatEvent — the measured wire', () => {
  it('normalises the converse `delta {text}` frame', () => {
    expect(parseChatEvent('delta', { text: 'hel' })).toEqual({ type: 'delta', text: 'hel' });
  });

  it('accepts a payload that repeats `type` and rejects one that contradicts the event name', () => {
    expect(parseChatEvent('delta', { type: 'delta', text: 'x' })).toEqual({ type: 'delta', text: 'x' });
    expect(parseChatEvent('delta', { type: 'tool_call', text: 'x' })).toBeNull();
  });

  it('drops a delta with no text rather than rendering "undefined"', () => {
    expect(parseChatEvent('delta', {})).toBeNull();
    expect(parseChatEvent('delta', { text: 42 })).toBeNull();
    expect(parseChatEvent('delta', 'not an object')).toBeNull();
  });

  it('carries the tool_call detail (name + input) the transcript renders', () => {
    const ev = parseChatEvent('tool_call', { name: 'chat:ask_choice', input: { prompt: 'Pick one' } });
    expect(ev).toEqual({ type: 'tool_call', name: 'chat:ask_choice', input: { prompt: 'Pick one' } });
    expect(parseChatEvent('tool_call', { name: '' })).toBeNull();
    expect(parseChatEvent('tool_call', { input: {} })).toBeNull();
  });

  it('parses the agent-chats provenance frame (engine + model, optional accountRoute)', () => {
    expect(parseChatEvent('provenance', { type: 'provenance', engine: 'loop', model: 'sonnet' })).toEqual({
      type: 'provenance',
      engine: 'loop',
      model: 'sonnet',
    });
    expect(
      parseChatEvent('provenance', { engine: 'claude-code', model: 'opus', accountRoute: 'primary' }),
    ).toEqual({ type: 'provenance', engine: 'claude-code', model: 'opus', accountRoute: 'primary' });
    expect(parseChatEvent('provenance', { engine: 'loop' })).toBeNull();
  });

  it('parses done with the agent-chats usage shape and converse’s bare done', () => {
    expect(
      parseChatEvent('done', {
        type: 'done',
        stopReason: 'complete',
        usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.01 },
        finalText: 'ignored extra',
      }),
    ).toEqual({ type: 'done', stopReason: 'complete', usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.01 } });
    expect(parseChatEvent('done', { costUsd: 0.2 })).toEqual({ type: 'done' });
  });

  it('never loses an error: a message-less error still parses', () => {
    expect(parseChatEvent('error', { message: 'boom' })).toEqual({ type: 'error', message: 'boom' });
    expect(parseChatEvent('error', {})).toEqual({ type: 'error', message: 'stream error' });
  });

  it('parses the state-channel frames', () => {
    const card = { prompt: 'p', correlationId: 'c1', createdAt: 1 };
    expect(parseChatEvent('card', { card })).toEqual({ type: 'card', card });
    expect(parseChatEvent('card', { card: { prompt: 'p' } })).toBeNull();
    expect(parseChatEvent('card_closed', { correlationId: 'c1' })).toEqual({ type: 'card_closed', correlationId: 'c1' });
    expect(parseChatEvent('state', { version: 3, snapshot: { openCards: [] } })).toEqual({
      type: 'state',
      version: 3,
      snapshot: { openCards: [] },
    });
  });

  it('returns null for frames nobody chose to render (heartbeat, run-meta, a domain event)', () => {
    expect(parseChatEvent('heartbeat', {})).toBeNull();
    expect(parseChatEvent('run-meta', { runId: 'r' })).toBeNull();
    expect(parseChatEvent('state-snapshot', { snapshot: {} })).toBeNull();
    expect(parseChatEvent('products', { items: [] })).toBeNull();
    expect(isChatEventType('token')).toBe(false); // the retired name is NOT quietly accepted
    expect(isChatEventType('tool_start')).toBe(false);
  });

  it('accepts every EVENT-channel name (so a new member cannot be added without a parser case)', () => {
    for (const t of EVENT_CHANNEL_TYPES) expect(isChatEventType(t)).toBe(true);
    // A minimal valid payload per event-channel member: none may parse to null.
    const minimal: Record<(typeof EVENT_CHANNEL_TYPES)[number], unknown> = {
      session: { sessionId: 's' },
      delta: { text: '' },
      tool_call: { name: 'x' },
      tool_result: { name: 'x' },
      provenance: { engine: 'e', model: 'm' },
      done: {},
      error: { message: 'm' },
    };
    for (const t of EVENT_CHANNEL_TYPES) {
      const ev = parseChatEvent(t, minimal[t]);
      expect(ev, `event-channel type "${t}" must parse from its minimal payload`).not.toBeNull();
      expect((ev as ChatEvent).type).toBe(t);
    }
  });
});

describe('ChatTurn — the one persisted-history shape', () => {
  it('round-trips the converse turn row shape, including an answered card in `tools`', () => {
    const turn: ChatTurn = {
      id: 't1',
      seq: 7,
      role: 'assistant',
      text: 'Which one?',
      createdAt: 1_757_000_000_000,
      source: 'text_typed',
      tools: [
        {
          name: 'chat:ask_choice',
          input: { prompt: 'Which one?', options: [{ option_id: 'a', label: 'A' }] },
          answered: { picks: [{ option_id: 'a', label: 'A' }], declined: false, at: 1_757_000_001_000 },
        },
      ],
      report: null,
      provenance: { engine: 'claude-code', model: 'anthropic/claude-opus-4-7' },
      workRefs: [{ ref: 'WI-2147227', kind: 'WI', title: 'P-004', state: 'open' }],
      planSlug: 'papercup-chat-one-component-one-contract-2026-09-06',
    };
    const page: ChatTurnsPage = { turns: [turn], hasMoreEarlier: false };
    const back = JSON.parse(JSON.stringify(page)) as ChatTurnsPage;
    expect(back).toEqual(page);
    // The answered card is derivable from tools[] alone — no second "cards" field.
    const answered = back.turns[0].tools?.filter((t) => t.answered) ?? [];
    expect(answered).toHaveLength(1);
    expect(answered[0].answered?.picks[0].option_id).toBe('a');
    expect(back.turns[0].planSlug).toBe('papercup-chat-one-component-one-contract-2026-09-06');
    expect(back.turns[0].tools?.[0].answered?.declined).toBe(false);
  });

  it('a system-authored deterministic update is a ChatTurn with a report and source "system"', () => {
    const update: ChatTurn = {
      id: 'u1',
      role: 'assistant',
      source: 'system',
      text: '📋 Fleet update — 2 items progressed',
      createdAt: 1,
      report: { plans: [{ title: 'Fleet status', items: [{ id: 'P-004', text: 'wip', status: 'wip' }] }] },
    };
    expect(update.report?.plans[0].items?.[0].id).toBe('P-004');
  });
});
