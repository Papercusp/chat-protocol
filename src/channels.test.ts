import { describe, expect, it } from 'vitest';
import {
  EVENT_CHANNEL_TYPES,
  STATE_CHANNEL_TYPES,
  TRANSIENT_CHANNEL_TYPES,
  isStateChannelEvent,
  isReplayableEvent,
  type ChatEvent,
  type ChatEventType,
} from './index';

// Every member of the ChatEvent union, listed exhaustively. If a new event
// type is added to ChatEvent, this list must be updated — the union-completeness
// test below then forces it into exactly one channel set, so a new transient
// action can never silently fall into the "replayed" default.
const ALL_EVENT_TYPES: ChatEventType[] = [
  'session',
  'token',
  'tool_start',
  'card',
  'card_closed',
  'state',
  'done',
  'error',
  'navigate',
];

describe('channel classification', () => {
  describe('isStateChannelEvent', () => {
    it('is true for last-write-wins state-channel events', () => {
      expect(isStateChannelEvent('card')).toBe(true);
      expect(isStateChannelEvent('card_closed')).toBe(true);
      expect(isStateChannelEvent('state')).toBe(true);
    });

    it('is false for append-only event-channel events', () => {
      expect(isStateChannelEvent('session')).toBe(false);
      expect(isStateChannelEvent('token')).toBe(false);
      expect(isStateChannelEvent('tool_start')).toBe(false);
      expect(isStateChannelEvent('done')).toBe(false);
      expect(isStateChannelEvent('error')).toBe(false);
    });

    it('is false for the transient navigate action (it is not state-channel)', () => {
      // navigate is a fire-once action, not last-write-wins state.
      expect(isStateChannelEvent('navigate')).toBe(false);
    });
  });

  describe('isReplayableEvent', () => {
    it('is true only for append-only event-channel events', () => {
      for (const t of EVENT_CHANNEL_TYPES) {
        expect(isReplayableEvent(t)).toBe(true);
      }
    });

    it('is false for last-write-wins state-channel events (snapshot, not replay)', () => {
      for (const t of STATE_CHANNEL_TYPES) {
        expect(isReplayableEvent(t)).toBe(false);
      }
    });

    it('is false for transient navigate — replaying it would re-navigate on reconnect', () => {
      // This is the documented contract: "Transient action, NOT replayed on
      // reconnect (it would re-navigate)." A consumer gating replay on
      // isReplayableEvent must NOT replay navigate.
      expect(isReplayableEvent('navigate')).toBe(false);
    });

    it('agrees with the channel partition for every event type', () => {
      for (const t of ALL_EVENT_TYPES) {
        // Replayable iff it is an EVENT-channel type — never a state or
        // transient type.
        const expected = (EVENT_CHANNEL_TYPES as readonly string[]).includes(t);
        expect(isReplayableEvent(t)).toBe(expected);
      }
    });
  });

  describe('channel partition completeness', () => {
    it('partitions every ChatEvent type into exactly one of EVENT / STATE / TRANSIENT', () => {
      const event = new Set<string>(EVENT_CHANNEL_TYPES);
      const state = new Set<string>(STATE_CHANNEL_TYPES);
      const transient = new Set<string>(TRANSIENT_CHANNEL_TYPES);

      for (const t of ALL_EVENT_TYPES) {
        const memberships = [event.has(t), state.has(t), transient.has(t)].filter(Boolean).length;
        expect(memberships, `type "${t}" must be in exactly one channel set, was in ${memberships}`).toBe(1);
      }
    });

    it('the three sets are mutually disjoint', () => {
      const event = new Set<string>(EVENT_CHANNEL_TYPES);
      const state = new Set<string>(STATE_CHANNEL_TYPES);
      const transient = new Set<string>(TRANSIENT_CHANNEL_TYPES);
      for (const t of state) expect(event.has(t)).toBe(false);
      for (const t of transient) {
        expect(event.has(t)).toBe(false);
        expect(state.has(t)).toBe(false);
      }
    });

    it('the union of the three sets covers the whole ChatEvent union (no orphan types)', () => {
      const covered = new Set<string>([
        ...EVENT_CHANNEL_TYPES,
        ...STATE_CHANNEL_TYPES,
        ...TRANSIENT_CHANNEL_TYPES,
      ]);
      expect(covered.size).toBe(ALL_EVENT_TYPES.length);
      for (const t of ALL_EVENT_TYPES) {
        expect(covered.has(t), `type "${t}" is not in any channel set`).toBe(true);
      }
    });

    it('classifies navigate as transient (not event, not state)', () => {
      expect((TRANSIENT_CHANNEL_TYPES as readonly string[]).includes('navigate')).toBe(true);
      expect((EVENT_CHANNEL_TYPES as readonly string[]).includes('navigate')).toBe(false);
      expect((STATE_CHANNEL_TYPES as readonly string[]).includes('navigate')).toBe(false);
    });
  });

  // Type-level guard: a sample value of each union member type-checks. Keeps
  // ALL_EVENT_TYPES honest against the actual ChatEvent shape.
  it('ALL_EVENT_TYPES matches the ChatEvent discriminant set', () => {
    const samples: ChatEvent[] = [
      { type: 'session', sessionId: 's' },
      { type: 'token', content: 'c' },
      { type: 'tool_start', tool: 't' },
      { type: 'card', card: { prompt: 'p', correlationId: 'c', createdAt: 0 } },
      { type: 'card_closed', correlationId: 'c' },
      { type: 'state', version: 1, snapshot: {} },
      { type: 'done' },
      { type: 'error', message: 'm' },
      { type: 'navigate', href: '/x' },
    ];
    const discriminants = samples.map((e) => e.type).sort();
    expect(discriminants).toEqual([...ALL_EVENT_TYPES].sort());
  });
});
