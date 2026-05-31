# @papercusp/chat-protocol

The **deps-free wire contract** for streaming agent chats: the SSE event
union (delta / tool / done / error …) plus the interactive-card protocol
(text / radio / confirm cards and their responses).

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
