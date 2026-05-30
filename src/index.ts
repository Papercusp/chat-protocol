/**
 * @papercusp/chat-protocol — the deps-free wire contract for streaming agent chats.
 *
 * One typed SSE event union + the interactive-card protocol, shared across
 * Restart (Scout) and papercusp. Domain-agnostic on purpose: products,
 * broaden-options, etc. are NOT here — consumers extend `ChatEvent` with their
 * own domain events (see Scout's `CopilotSSEEvent`).
 *
 * Pure types + tiny guards; zero runtime deps so a NestJS backend, an Astro/React
 * frontend, and the papercusp operator can all import it without pulling React,
 * zod, or postgres.
 */

// ---------------------------------------------------------------------------
// Interactive cards — the model pauses mid-turn, asks the user, resumes.
// (Generalized from papercusp's CardSpec/CardResponse/OpenCardSnapshot.)
// ---------------------------------------------------------------------------

export type CardPresentationKind = 'radio' | 'checkbox' | 'text' | 'date' | 'slider';

export interface CardOption {
  /** Stable id returned in the response (e.g. "grade_a"). */
  id: string;
  label: string;
  description?: string;
  /** Optional secondary hint text (papercusp wire field; optional for back-compat). */
  hint?: string;
  /** Optional visual emphasis (papercusp wire field; optional for back-compat). */
  style?: 'default' | 'primary' | 'danger';
}

export interface CardPresentation {
  kind: CardPresentationKind;
  /** radio / checkbox choices. */
  options?: CardOption[];
  /** text input placeholder. */
  placeholder?: string;
  /** text only: render a multi-line input (papercusp wire field; optional). */
  multiline?: boolean;
  /**
   * Bounds. `number` for slider; ISO date `string` for the `date` kind
   * (papercusp uses string date bounds — widened for back-compat; consumers
   * that only do slider math read these as numbers).
   */
  min?: number | string;
  max?: number | string;
  step?: number;
  /**
   * radio only: the option set can be answered by voice (papercusp wire field;
   * optional for back-compat). Voice surfaces read the options for spoken answering.
   */
  voiceAnswerable?: boolean;
}

/** What the model asks for via `ask_choice` / `present_card`. */
export interface CardSpec {
  prompt: string;
  /**
   * Visual presentation hint. Optional: a plain prompt (voice / text-only /
   * confirm) may omit it. (papercusp emits presentation-less cards; widened to
   * optional for back-compat — builders that always set it are unaffected.)
   */
  presentation?: CardPresentation;
  /** Plain-text rendering for voice / no-UI clients. */
  fallbackText?: string;
  /** Allow the user to dismiss without answering. */
  allowDecline?: boolean;
  /** Auto-cancel after this many ms (server resolves as `cancel`). */
  timeoutMs?: number;
}

/** The card as it appears on the wire (state channel) — a CardSpec plus identity. */
export interface OpenCardSnapshot extends CardSpec {
  correlationId: string;
  /** epoch ms */
  createdAt: number;
  /**
   * The response schema serialized as JSON Schema (papercusp wire field; optional
   * for back-compat). papercusp validates submissions against the source zod
   * schema server-side and ships the JSON-Schema form for renderers.
   */
  dataSchemaJson?: Record<string, unknown>;
}

/**
 * The user's answer, POSTed back out-of-band and correlated by `correlationId`.
 * `value` shape follows the presentation: radio → { optionId }, checkbox →
 * { optionIds }, text → { text }, slider → { value }, date → { date }.
 */
export type CardResponse =
  | { action: 'submit'; correlationId: string; value: Record<string, unknown> }
  | { action: 'decline'; correlationId: string }
  | { action: 'cancel'; correlationId: string };

// ---------------------------------------------------------------------------
// SSE event union — the streamed chat protocol.
// ---------------------------------------------------------------------------

/**
 * Generic, domain-agnostic chat events. Consumers union their own domain events
 * onto this (e.g. `type ScoutEvent = ChatEvent | { type: 'products'; … }`).
 *
 * Two channels by convention:
 *  - EVENT channel (append-only, replayable): session, token, tool_start, done, error
 *  - STATE channel (last-write-wins, NOT replayed as history): card, card_closed, state
 *    — so a reconnect after answering a card never re-prompts.
 */
export type ChatEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'token'; content: string }
  | { type: 'tool_start'; tool: string }
  | { type: 'card'; card: OpenCardSnapshot }
  | { type: 'card_closed'; correlationId: string }
  | { type: 'state'; version: number; snapshot: unknown }
  | { type: 'done'; usage?: { totalTokens?: number; costUsd?: number } }
  | { type: 'error'; message: string };

export type ChatEventType = ChatEvent['type'];

/** Event-channel types (append-only, safe to replay on reconnect). */
export const EVENT_CHANNEL_TYPES = ['session', 'token', 'tool_start', 'done', 'error'] as const;
/** State-channel types (last-write-wins; do NOT replay as history). */
export const STATE_CHANNEL_TYPES = ['card', 'card_closed', 'state'] as const;

/** True for events that belong on the last-write-wins state channel. */
export function isStateChannelEvent(type: ChatEventType): boolean {
  return (STATE_CHANNEL_TYPES as readonly string[]).includes(type);
}
