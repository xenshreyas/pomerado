import type { ModelProvider, ModelRequest, ModelSettings, Usage } from "@openai/agents";
import type { Capability } from "@openai/agents/sandbox";
import { Data, Schema } from "effect";

/** Which agent a model call is for. */
export type ModelRole = "minter" | "guardian" | "outcome_reviewer";

/**
 * One request's needs in neutral terms, which a backend shapes into its provider's request. An
 * in-process value: it is never serialized and never sent.
 */
export interface ModelIntent {
  readonly effort: "low" | "medium";
  /**
   * Reasoning from earlier turns stays in view, as in a conversation that continues across
   * reviews, not only the current turn's.
   */
  readonly continuity: boolean;
  /** Whether one response may call several tools. */
  readonly parallelToolCalls: boolean;
  /**
   * `key` keeps a set of requests' cache accounting apart, such as one per environment;
   * `compareWith` names an earlier response whose cache reuse the provider should report on.
   */
  readonly cache?: { readonly key?: string; readonly compareWith?: string };
  /**
   * The host's text that follows the instructions in every request of a release, cached with
   * them, such as the minter's static context.
   */
  readonly staticContext?: readonly string[];
  /**
   * The agent's instructions in the parts they join, with a blank line between, into its
   * instructions, such as Guardian's shared policy, then the build's own. The first is the same
   * for every conversation of a release, so it is cached longest.
   */
  readonly instructionParts?: readonly string[];
  /** The request's tools the model may call; the others are still sent. All, when absent. */
  readonly offeredTools?: readonly string[];
  /** The input size, in tokens, at which the provider compacts the conversation. */
  readonly compactAtTokens?: number;
  /** Writes the cached prefix without generating output, instead of a real request. */
  readonly prewarm?: boolean;
}

/**
 * What a backend sets on a role's agent rather than on each request, since the SDK reads model
 * settings and capabilities, such as compaction, from the agent.
 */
export interface AgentShaping {
  readonly modelSettings: ModelSettings;
  /** For a sandbox agent, such as the minter's; a plain agent, such as Guardian's, takes none. */
  readonly capabilities: readonly Capability[];
}

/** The intent features a backend honors. A caller skips the work for one its backend lacks. */
export interface BackendFeatures {
  /**
   * Compacting a conversation apart from its requests: the minter's idle compaction, and Guardian's
   * compaction before a request and its backstop.
   */
  readonly backgroundCompaction: boolean;
  /** Reporting a response's prompt cache reuse against an earlier one (`cache.compareWith`). */
  readonly cacheDiagnostics: boolean;
  /**
   * A review's effort can change within a conversation and keep its cached prefix. Without it, each
   * request carries its review's effort as `intent.effort`.
   */
  readonly effortChangeKeepsCache: boolean;
}

/**
 * Pomerado's module for one model provider: the agents describe what they need as a
 * `ModelIntent`, and the backend owns how its provider's requests say it.
 */
export interface ModelBackend {
  /** Stable id, recorded in snapshots so that only the backend that wrote one resumes it. */
  readonly id: "openai" | "anthropic" | (string & {});
  /** The model a role runs on (IDs come from models.ts). */
  readonly model: (role: ModelRole) => string;
  readonly agent: (role: ModelRole, intent: ModelIntent) => AgentShaping;
  /**
   * The provider a role's Runner uses: the backend's shaping over `base`, with each request's
   * intent from `intentOf`. `base` is the host's own provider option for the role, when it sets
   * one; without it the backend uses its own default.
   */
  readonly provider: (
    role: ModelRole,
    intentOf: (request: ModelRequest) => ModelIntent,
    base?: ModelProvider,
  ) => ModelProvider;
  readonly features: BackendFeatures;
  /**
   * Writes a role's cached instructions without generating output: `run` runs the role's agent
   * once through the provider it is given, and the backend sends that run's request as the
   * prewarm. Resolves with its token counts. A backend that can't prewarm leaves it out, and its
   * callers skip the prewarm.
   */
  readonly prewarm?: (
    role: ModelRole,
    intent: ModelIntent,
    base: ModelProvider | undefined,
    run: (provider: ModelProvider) => Promise<unknown>,
  ) => Promise<Usage>;
}

/** The backend and model a saved conversation was written with. */
export const BackendTag = Schema.Struct({ id: Schema.String, model: Schema.String });
export type BackendTag = typeof BackendTag.Type;

/** A role's tag on `backend`. */
export const backendTag = (backend: ModelBackend, role: ModelRole): BackendTag => ({
  id: backend.id,
  model: backend.model(role),
});

/**
 * The version a snapshot is written as: 1 for OpenAI's, which every release reads, and 2 for
 * another backend's, which a release from before backend tags refuses instead of resuming it.
 */
export const snapshotVersion = (tag: BackendTag): 1 | 2 => (tag.id === "openai" ? 1 : 2);

/** A snapshot written on another backend than the one resuming it. The host starts afresh. */
export class SnapshotBackendMismatch extends Data.TaggedError("SnapshotBackendMismatch")<{
  readonly snapshot: string;
  readonly backend: string;
}> {}

/**
 * The mismatch when a snapshot `written` on a backend resumes on `tag`'s, or undefined when it
 * resumes: an untagged snapshot is OpenAI's.
 */
export const backendMismatch = (
  written: BackendTag | undefined,
  tag: BackendTag,
): SnapshotBackendMismatch | undefined => {
  const snapshot = written?.id ?? "openai";
  return snapshot === tag.id
    ? undefined
    : new SnapshotBackendMismatch({ snapshot, backend: tag.id });
};
