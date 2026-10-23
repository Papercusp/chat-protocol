# @papercusp/chat-protocol

The **deps-free wire contract** for streaming agent chats: the SSE event
union (delta / tool / done / error …), the interactive-card protocol
(text / radio / confirm cards and their responses), and the tagged
structured-content blocks embeddable inline in turn text — `ReportBlock`
(`<report>{json}</report>`, a two-tier plan→item status list) and `AskBlock`
(`<ask>{json}</ask>`, a durable owner-directed question with optional
choices/refs). Each block ships a schema, a tolerant defensive parser (never
throws — malformed input drops to `null`), and, for `AskBlock`, a
raw-tag serializer for callers that construct the tag programmatically.

Zero runtime dependencies, zero React, zero domain types — just TypeScript
types + a few zod schemas describing the bytes on the wire. The backend, the
frontend, and any other client can all import it without pulling a UI
framework or a product's domain model.

Domain-agnostic on purpose: products extend the base types for their own
card kinds. Shared across Restart (Scout) and Papercusp; either side can
evolve its own surface as long as it stays compatible with this contract.

## Status

Submodule under `github.com/Papercusp/`. Generalized from Papercusp's
original `CardSpec` / `CardResponse` / `OpenCardSnapshot` shapes.

## Versioned adoption

`ChatEventEnvelope` and `ChatStateV1` use `schemaVersion: 1`. Envelopes require
host-allocated conversation, turn and event IDs plus a positive per-turn sequence;
tool events require a stable call ID. Parsing validates the contract, while the
host store owns authorization, cursor ordering, retention and atomic mutations.
No parser starts a turn, allocates identity, dispatches a tool or grants access.

`negotiateChatVersion` accepts exactly explicit versions 0 and 1. Missing, future
or invalid versions fail with `unsupported-version`. Unversioned existing wire
frames are **legacy0**, consumed only by the explicitly selected
`decodeLegacyChatFrame` / `upgradeLegacyChatFrame` host adapter. Scout's measured
`token/content` and `tool_start/tool` vocabulary maps to `delta/text` and
`tool_call/name`; Papercup retains its existing vocabulary. A legacy tool event
without call identity requires the host's stable mapping. Unknown result status
is refused rather than fabricated. New features without a legacy representation
return `unsupported-event` from `encodeLegacyChatFrame`; the host must choose a
deliberate fallback. Existing `parseChatEvent` behavior is unchanged.

V1 normalizes lifecycle (including cancelled, interrupted and needs-reconciliation),
errors with explicit retry permission, provider provenance, grounded result blocks
and recovery capabilities. Result sources are opaque references; hosts authorize
their resolution and render strings through their safe components. These types
do not make model output executable. Capability declarations independently name
connection replay, persisted history, persisted decisions, completed-tool
checkpoints and interrupted-turn recovery. `requireChatCapabilities` refuses an
unsupported request; persisted history never implies restart recovery.

This is the wire/state contract. Durable production stores, compatibility of
specific shipped artifacts and host adoption need their own behavioral evidence.

## Turn recovery

`@papercusp/chat-protocol/recovery` exports `TurnRecovery` and its host adapter
interfaces. The adapter supplies current caller authorization, the existing
session store's atomic compare-and-swap, its SSE/event replay window, and an
abort hook for host-owned execution. A turn starts with host-authorized effect
identities. Each effect is claimed before dispatch; completed results are reused.
Dispatch errors and uncertain claim acknowledgements return
`needs-reconciliation`. Hosts reconcile unknown outcomes through their existing
effect/idempotency lookup and persist verified results through the same CAS seam;
model retries never authorize redispatch.

Checkpoint-write failure remains explicit. If a completion committed but its
acknowledgement was lost, the component reads the stored result before returning.
Cancellation commits before invoking the host abort hook; an in-flight effect's
completed result is retained without reopening the cancelled turn. The dispatch
signal must belong to that host execution so the abort hook reaches it.

Replay windows report their retained lower bound and latest sequence, including
when empty. The component rejects gaps, reordered/foreign frames, stale cursors
and cursors beyond the latest event. Hosts return the complete retained suffix
after the requested cursor, using their existing transport buffer or persistence.
Lightweight profiles can advertise connection replay while explicitly refusing
restart recovery. The deterministic worker/store tests are tree evidence;
production restart durability still requires each host's persistent adapter tests.
