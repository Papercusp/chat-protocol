import type { OpenCardSnapshot } from "./index.js";

/**
 * Stable, dependency-free wire contract between an SU-session host and clients
 * such as PUI. Runtime adapters may use provider SDKs internally, but none of
 * those types cross this boundary.
 */
export const SU_SESSION_SCHEMA = "papercusp.su-session/v1" as const;
export const SU_SESSION_PROTOCOL_VERSION = 1 as const;

export const SU_SESSION_BACKENDS = ["claude", "codex", "omp"] as const;
export type SuSessionBackend = (typeof SU_SESSION_BACKENDS)[number];

/** Provider and execution transport are independent choices. */
export const SU_SESSION_EXECUTION_KINDS = ["pty", "programmatic"] as const;
export type SuSessionExecutionKind = (typeof SU_SESSION_EXECUTION_KINDS)[number];

export function isSuSessionExecutionKind(value: unknown): value is SuSessionExecutionKind {
  return typeof value === "string" && (SU_SESSION_EXECUTION_KINDS as readonly string[]).includes(value);
}

export type SuSessionExecutionSelectionInput = {
  provider: SuSessionBackend;
  /** Preserve presence: [] or an invalid value is a refusal, never omission. */
  requestedKinds?: readonly unknown[];
  supportedKinds?: readonly SuSessionExecutionKind[];
} & (
  | { operation: "create"; headless: boolean; defaultKind: SuSessionExecutionKind }
  | { operation: "existing"; savedKind?: unknown; legacyKind?: unknown }
);

export type SuSessionExecutionSelection =
  | { ok: true; provider: SuSessionBackend; executionKind: SuSessionExecutionKind;
      source: "explicit" | "headless-default" | "client-default" | "saved" | "legacy" }
  | { ok: false; refusal: SuSessionRefusal };

/** Ordered launch policy; reconnects never invoke the new-session default. */
export function selectSuSessionExecution(input: SuSessionExecutionSelectionInput): SuSessionExecutionSelection {
  const refuse = (code: string, message: string): SuSessionExecutionSelection =>
    ({ ok: false, refusal: { code, message, retryable: false } });
  let requested: SuSessionExecutionKind | undefined;
  if (Object.prototype.hasOwnProperty.call(input, "requestedKinds")) {
    if (!Array.isArray(input.requestedKinds) || input.requestedKinds.length === 0
      || !Array.from(input.requestedKinds).every(isSuSessionExecutionKind)) {
      return refuse("invalid_execution_kind", "An explicit execution choice must be pty or programmatic.");
    }
    const choices = new Set(input.requestedKinds);
    if (choices.size !== 1) return refuse("conflicting_execution_kinds", "Conflicting execution choices require one explicit selection.");
    requested = input.requestedKinds[0] as SuSessionExecutionKind;
  }
  let executionKind: SuSessionExecutionKind;
  let source: Extract<SuSessionExecutionSelection, { ok: true }>["source"];
  if (input.operation === "existing") {
    const hasSaved = Object.prototype.hasOwnProperty.call(input, "savedKind");
    const saved = hasSaved ? input.savedKind : input.legacyKind;
    if (!hasSaved && !isSuSessionExecutionKind(saved)) {
      return refuse("unknown_existing_execution_kind", "The existing runtime's execution kind must be established before reconnecting.");
    }
    if (!isSuSessionExecutionKind(saved)) return refuse("invalid_saved_execution_kind", "The saved execution choice must be reconciled before reconnecting.");
    if (requested && requested !== saved) return refuse("execution_handoff_required", "Changing an existing session's execution kind requires an explicit handoff.");
    executionKind = saved;
    source = hasSaved ? "saved" : "legacy";
  } else if (requested) {
    executionKind = requested;
    source = "explicit";
  } else if (input.headless && (input.provider === "claude" || input.provider === "codex")) {
    executionKind = "programmatic";
    source = "headless-default";
  } else {
    executionKind = input.defaultKind;
    source = "client-default";
  }
  if (!isSuSessionExecutionKind(executionKind)
    || !(input.supportedKinds ?? SU_SESSION_EXECUTION_KINDS).includes(executionKind)) {
    return refuse("unsupported_execution_kind", "The selected execution kind is unavailable; no fallback was launched.");
  }
  return { ok: true, provider: input.provider, executionKind, source };
}

export const SU_SESSION_LIFECYCLE_STATES = [
  "starting",
  "ready",
  "running",
  "waiting-for-owner",
  "interrupted",
  "compacting",
  "resuming",
  "ended",
  "failed",
] as const;
export type SuSessionLifecycleState =
  (typeof SU_SESSION_LIFECYCLE_STATES)[number];

export const SU_SESSION_LEGACY_COMMAND_TYPES = [
  "owner_turn",
  "interrupt",
  "resume",
  "fork",
  "focus",
  "end",
] as const;
export type SuSessionLegacyCommandType = (typeof SU_SESSION_LEGACY_COMMAND_TYPES)[number];
export const SU_SESSION_EXTENDED_COMMAND_TYPES = ["queue", "steer", "handoff"] as const;
export type SuSessionExtendedCommandType = (typeof SU_SESSION_EXTENDED_COMMAND_TYPES)[number];
export const SU_SESSION_COMMAND_TYPES = [
  ...SU_SESSION_LEGACY_COMMAND_TYPES, ...SU_SESSION_EXTENDED_COMMAND_TYPES,
] as const;
export type SuSessionCommandType = (typeof SU_SESSION_COMMAND_TYPES)[number];

export const SU_SESSION_INPUT_PART_TYPES = ["text", "image", "file"] as const;
export type SuSessionInputPartType = (typeof SU_SESSION_INPUT_PART_TYPES)[number];
/** Transport-neutral attachments. A runtime must refuse a part it cannot deliver. */
export type SuSessionInputPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }
  | { type: "file"; uri: string; mediaType: string; name?: string;
      /** New file delivery requires a workspace-bound project: URI and digest.
       * Optional on the wire so old clients receive a typed delivery refusal. */
      workspaceId?: string; sha256?: string; expiresAt?: string };

export const SU_SESSION_MESSAGE_ORIGINS = ["owner", "coordination", "system", "runtime"] as const;
export type SuSessionMessageOriginKind = (typeof SU_SESSION_MESSAGE_ORIGINS)[number];
/** Provenance is retained as data; coordination input is never relabelled owner input. */
export interface SuSessionMessageOrigin {
  kind: SuSessionMessageOriginKind;
  actorId?: string;
  sourceId?: string;
}

export interface SuSessionTurnInput {
  turnId: string;
  /** Legacy text remains exact; rich parts supplement it, never replace it silently. */
  content: string;
  input?: readonly SuSessionInputPart[];
  model?: string;
  approvals?: SuApprovalsMode;
}

export const SU_SESSION_EVENT_TYPES = [
  "session",
  "lifecycle",
  "command_result",
  "transcript",
  "tool",
  "card",
  "backend",
  "error",
] as const;
export type SuSessionEventType = (typeof SU_SESSION_EVENT_TYPES)[number];

/**
 * Feature keys every backend must declare. `features` is a total record over
 * this union. Extended command keys are optional for legacy descriptor readers;
 * an absent key is unsupported, and current adapters publish every command key.
 *
 * Semantics, so an engine attests to the same question the PUI asks:
 * - `tool-events`       tool calls/results surface as structured events.
 * - `interactive-cards` typed owner-input cards reach the PUI.
 * - `reasoning-stream`  assistant reasoning is streamed on the `reasoning` channel.
 * - `usage`             token/cost metadata reaches the client.
 * - `compaction`        the session survives a context compaction / carry.
 * - `approvals`         a tool-permission request is put to the OWNER and their
 *                       decision governs the call — not silently auto-approved.
 * - `context`           the client can read context consumption/headroom for the
 *                       session (what a PUI context gauge would render).
 * - `modes`             the session's operating modes are reported to the client
 *                       and can be changed through this contract.
 */
export const SU_SESSION_FEATURES = [
  "tool-events",
  "interactive-cards",
  "reasoning-stream",
  "usage",
  "compaction",
  "approvals",
  "context",
  "modes",
] as const;
export type SuSessionFeature = (typeof SU_SESSION_FEATURES)[number];

/** JSON-only value carried by tool and error events. */
export type SuSessionJsonValue =
  | null
  | boolean
  | number
  | string
  | SuSessionJsonValue[]
  | { [key: string]: SuSessionJsonValue };

/**
 * Durable identity survives PUI restarts and runtime-process replacement.
 * `agentChatId` binds the contract to the existing agent-chats transport;
 * `advSessionId` plus the backend-native id govern reconciliation/resume.
 */
export interface SuSessionIdentity<
  B extends SuSessionBackend = SuSessionBackend,
> {
  agentChatId: string;
  advSessionId: number;
  backend: B;
  nativeSessionId: string;
  ownerId: string;
  workspaceId: string;
  harnessSlug: string | null;
}

/**
 * Backend-specific metadata that clients may render or use for diagnostics.
 * These shapes deliberately mirror already-shipped native-session handles.
 */
export interface SuSessionBackendExtensionMap {
  claude: {
    configDir: string | null;
    configDirSource: string | null;
  };
  codex: {
    codexHome: string | null;
  };
  omp: {
    agentHome: string | null;
  };
}

export type SuSessionBackendExtension<
  B extends SuSessionBackend = SuSessionBackend,
> = B extends SuSessionBackend
  ? { backend: B } & SuSessionBackendExtensionMap[B]
  : never;

/**
 * `host` means Papercusp supplies the behavior around the native runtime (for
 * example pane focus). There is intentionally no "simulated" value: unsupported
 * backend behavior must remain visible instead of being silently imitated.
 */
export type SuSessionCapabilitySupport =
  | { state: "supported"; implementation: "native" | "host" }
  | { state: "conditional"; implementation: "native" | "host"; reason: string }
  | { state: "unsupported"; reason: string };

export const SU_SESSION_CAPABILITIES_VERSION = 2 as const;
export interface SuSessionCapabilities {
  /** Omission means the legacy capability shape; absent extensions are unsupported. */
  version?: typeof SU_SESSION_CAPABILITIES_VERSION;
  commands: Readonly<Record<SuSessionLegacyCommandType, SuSessionCapabilitySupport>
    & Partial<Record<SuSessionExtendedCommandType, SuSessionCapabilitySupport>>>;
  features: Readonly<Record<SuSessionFeature, SuSessionCapabilitySupport>>;
  input?: {
    parts: readonly SuSessionInputPartType[];
    origins: readonly SuSessionMessageOriginKind[];
  };
}

/**
 * Engine-neutral approvals modes (plan pui-chat-first-ux-2026-09-28 D-026).
 * `ask`: ask before edits and commands. `auto-edit`: make edits without
 * asking, ask before other commands. `read-only`: look and plan, change
 * nothing. There is deliberately no full-access mode.
 */
export const SU_APPROVALS_MODES = ["ask", "auto-edit", "read-only"] as const;
export type SuApprovalsMode = (typeof SU_APPROVALS_MODES)[number];

export function isSuApprovalsMode(value: unknown): value is SuApprovalsMode {
  return typeof value === "string" && (SU_APPROVALS_MODES as readonly string[]).includes(value);
}

/**
 * Token, context and cost measurements for a session (plan
 * pui-chat-first-ux-2026-09-28 D-029 / D-031). Every field is optional: a field
 * the engine cannot measure is omitted, never guessed. `contextTokens` is what
 * the latest model call put in the context window; `costUsd` is the running
 * session total, never a per-turn delta.
 */
export interface SuSessionUsage {
  contextTokens?: number;
  contextWindow?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/**
 * One model the ENGINE reports it can run (WI-10006652): Claude's SDK
 * initialization catalog, Codex's `model/list`. This is what a chat user picks
 * from, not the workspace's fleet routing tiers. `id` is the value an
 * owner_turn `model` spec names (`id[:effort]`).
 */
export interface SuSessionModelOption {
  id: string;
  label: string;
  description?: string;
  /** The canonical model an alias `id` resolves to (Claude `sonnet` → `claude-sonnet-5`). */
  resolvedModel?: string;
  efforts?: readonly string[];
  defaultEffort?: string;
  /** The engine's own default pick. */
  isDefault?: boolean;
}

export const SU_PLAN_ITEM_STATUSES = ["pending", "in_progress", "completed"] as const;
export type SuPlanItemStatus = (typeof SU_PLAN_ITEM_STATUSES)[number];

/** One row of the agent's own todo/plan list (Claude TodoWrite, Codex plan updates). */
export interface SuPlanItem {
  text: string;
  status: SuPlanItemStatus;
}

export type SuSessionDescriptor<B extends SuSessionBackend = SuSessionBackend> =
  B extends SuSessionBackend
    ? {
        identity: SuSessionIdentity<B>;
        /** Omitted only by legacy snapshots; omission is never a creation default. */
        executionKind?: SuSessionExecutionKind;
        lifecycle: SuSessionLifecycleState;
        /** Increments when a replacement runtime attaches to the same identity. */
        runtimeGeneration: number;
        role: "su";
        model: string | null;
        /** The latest model spec explicitly selected by the owner via /model.
         * Native engines may report only a resolved model id; keep the owner's
         * full spec (including effort) across process restart separately. */
        ownerSelectedModel?: string | null;
        /**
         * The approvals mode the engine runs in now (plan D-026). Omitted by an
         * engine that has no switchable mode (OMP always asks).
         */
        approvals?: SuApprovalsMode;
        /**
         * D-031: the latest usage measurements, merged field by field. Carried on
         * the descriptor (published by a `session` event) rather than a new
         * event type, so clients that predate it ignore it instead of failing to
         * decode the stream. Omitted until the engine reports anything.
         */
        usage?: SuSessionUsage;
        /**
         * D-031: the agent's latest todo/plan list; each update replaces the
         * whole list. Omitted by an engine that has no plan tool.
         */
        plan?: readonly SuPlanItem[];
        /**
         * WI-10006652: the models this engine can switch to, as the engine
         * itself reports them. Omitted until the engine has answered; a client
         * then falls back to its own menu.
         */
        models?: readonly SuSessionModelOption[];
        /** The account that actually served the latest completed native turn. */
        accountServed: string | null;
        accountRoute: string | null;
        carry: "warm" | "cold";
        modes: readonly string[];
        capabilities: SuSessionCapabilities;
        backendExtension: SuSessionBackendExtension<B>;
      }
    : never;

export interface SuSessionCommandBase<
  B extends SuSessionBackend,
  T extends SuSessionCommandType,
> {
  schema: typeof SU_SESSION_SCHEMA;
  protocolVersion: typeof SU_SESSION_PROTOCOL_VERSION;
  type: T;
  commandId: string;
  issuedAt: string;
  target: SuSessionIdentity<B>;
  /** Omitted only by legacy owner clients. */
  origin?: SuSessionMessageOrigin;
  /** Optional optimistic fence; stale clients cannot command a replacement runtime. */
  expectedRuntimeGeneration?: number;
}

export type SuSessionCommandFor<B extends SuSessionBackend> =
  | (SuSessionCommandBase<B, "owner_turn"> & SuSessionTurnInput & {
      /**
       * The model this turn and later ones run on, as a `model[:effort]`
       * spec. Omitted keeps the current model. The engine applies it before
       * the turn, so a refused switch refuses the turn rather than running
       * it on a model the owner did not pick.
       */
      model?: string;
      /**
       * The approvals mode this turn and later ones run in (plan D-026).
       * Omitted keeps the current mode. Like `model`, a refused switch
       * refuses the turn.
       */
      approvals?: SuApprovalsMode;
    })
  /** Queue waits for the active turn; steer targets that exact active turn. */
  | (SuSessionCommandBase<B, "queue"> & SuSessionTurnInput)
  | (SuSessionCommandBase<B, "steer"> & SuSessionTurnInput & { activeTurnId: string })
  | (SuSessionCommandBase<B, "handoff"> & {
      provider: SuSessionBackend;
      executionKind: SuSessionExecutionKind;
      expectedRuntimeGeneration: number;
      reason?: string;
    })
  | (SuSessionCommandBase<B, "interrupt"> & {
      reason?: string;
    })
  | (SuSessionCommandBase<B, "resume"> & {
      cause: "owner" | "pui-restart" | "runtime-replacement" | "compaction";
    })
  | (SuSessionCommandBase<B, "fork"> & {
      /** Omit to fork from the latest acknowledged sequence. */
      fromSequence?: number;
    })
  | SuSessionCommandBase<B, "focus">
  | (SuSessionCommandBase<B, "end"> & {
      reason?: string;
    });

export type SuSessionCommand<B extends SuSessionBackend = SuSessionBackend> =
  B extends SuSessionBackend ? SuSessionCommandFor<B> : never;

export interface SuSessionEventBase<
  B extends SuSessionBackend,
  T extends SuSessionEventType,
> {
  schema: typeof SU_SESSION_SCHEMA;
  protocolVersion: typeof SU_SESSION_PROTOCOL_VERSION;
  type: T;
  eventId: string;
  /** Strictly increasing within one durable session, including reconnects. */
  sequence: number;
  at: string;
  session: SuSessionIdentity<B>;
}

export interface SuSessionRefusal {
  code: string;
  message: string;
  retryable: boolean;
  /** An actionable condition for a new command; retrying this command id replays the refusal. */
  liftsWhen?: string;
}

export type SuSessionCommandResultEvent<B extends SuSessionBackend> =
  SuSessionEventBase<B, "command_result"> &
    (
      | {
          commandId: string;
          commandType: SuSessionCommandType;
          status: "accepted";
        }
      | {
          commandId: string;
          commandType: SuSessionCommandType;
          status: "completed";
        }
      | {
          commandId: string;
          commandType: SuSessionCommandType;
          status: "refused";
          refusal: SuSessionRefusal;
        }
    );

export type SuSessionTranscriptEvent<B extends SuSessionBackend> =
  SuSessionEventBase<B, "transcript"> & { origin?: SuSessionMessageOrigin } &
    (
      | {
          phase: "started";
          turnId: string;
          role: "owner" | "assistant" | "system";
          channel: "text" | "reasoning";
        }
      | {
          phase: "delta";
          turnId: string;
          role: "owner" | "assistant" | "system";
          channel: "text" | "reasoning";
          content: string;
        }
      | {
          phase: "completed";
          turnId: string;
          role: "owner" | "assistant" | "system";
          channel: "text" | "reasoning";
          content?: string;
        }
    );

export type SuSessionToolEvent<B extends SuSessionBackend> = SuSessionEventBase<
  B,
  "tool"
> &
  (
    | {
        phase: "started";
        turnId: string;
        callId: string;
        name: string;
        input?: SuSessionJsonValue;
      }
    | {
        phase: "completed";
        turnId: string;
        callId: string;
        name: string;
        output?: SuSessionJsonValue;
        isError: boolean;
      }
  );

export type SuSessionCardEvent<B extends SuSessionBackend> = SuSessionEventBase<
  B,
  "card"
> &
  (
    | {
        phase: "opened";
        turnId: string;
        card: OpenCardSnapshot;
      }
    | {
        phase: "closed";
        turnId: string;
        correlationId: string;
        resolution:
          | "submitted"
          | "declined"
          | "cancelled"
          | "expired"
          | "interrupted";
      }
  );

export type SuSessionEventFor<B extends SuSessionBackend> =
  | (SuSessionEventBase<B, "session"> & {
      descriptor: SuSessionDescriptor<B>;
    })
  | (SuSessionEventBase<B, "lifecycle"> & {
      previousState: SuSessionLifecycleState | null;
      state: SuSessionLifecycleState;
      runtimeGeneration: number;
      reason?: string;
    })
  | SuSessionCommandResultEvent<B>
  | SuSessionTranscriptEvent<B>
  | SuSessionToolEvent<B>
  | SuSessionCardEvent<B>
  | (SuSessionEventBase<B, "backend"> & {
      extension: SuSessionBackendExtension<B>;
    })
  | (SuSessionEventBase<B, "error"> & {
      scope: "session" | "command" | "turn" | "transport";
      code: string;
      message: string;
      recoverable: boolean;
      commandId?: string;
      details?: SuSessionJsonValue;
    });

export type SuSessionEvent<B extends SuSessionBackend = SuSessionBackend> =
  B extends SuSessionBackend ? SuSessionEventFor<B> : never;

export function isSuSessionBackend(value: string): value is SuSessionBackend {
  return (SU_SESSION_BACKENDS as readonly string[]).includes(value);
}

export function isSuSessionLifecycleState(
  value: string,
): value is SuSessionLifecycleState {
  return (SU_SESSION_LIFECYCLE_STATES as readonly string[]).includes(value);
}

export function isSuSessionCommandType(
  value: string,
): value is SuSessionCommandType {
  return (SU_SESSION_COMMAND_TYPES as readonly string[]).includes(value);
}

export function isSuSessionEventType(
  value: string,
): value is SuSessionEventType {
  return (SU_SESSION_EVENT_TYPES as readonly string[]).includes(value);
}

/** Use in switch defaults so a new union member strands every incomplete handler. */
export function assertNeverSuSession(value: never): never {
  throw new Error(
    `Unhandled SU-session contract member: ${JSON.stringify(value)}`,
  );
}
