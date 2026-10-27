import type { ModelProvider, ModelRequest, ModelSettings, Usage } from "@openai/agents";
import type { Capability } from "@openai/agents/sandbox";

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

/**
 * Pomerado's module for one model provider: the agents describe what they need as a
 * `ModelIntent`, and the backend owns how its provider's requests say it.
 */
export interface ModelBackend {
  /** The model a role runs on (IDs come from models.ts). */
  readonly model: (role: ModelRole) => string;
  readonly agent: (role: ModelRole, intent: ModelIntent) => AgentShaping;
  /**
   * The provider a role's Runner uses: the backend's shaping over `base`, the provider the Runner
   * resolved (the host's option, or the SDK default resolved at call time), with each request's
   * intent from `intentOf`.
   */
  readonly provider: (
    role: ModelRole,
    intentOf: (request: ModelRequest) => ModelIntent,
    base: ModelProvider,
  ) => ModelProvider;
  /**
   * Writes a role's cached instructions without generating output: `run` runs the role's agent
   * once through the provider it is given, and the backend sends that run's request as the
   * prewarm. Resolves with its token counts.
   */
  readonly prewarm: (
    role: ModelRole,
    intent: ModelIntent,
    base: ModelProvider,
    run: (provider: ModelProvider) => Promise<unknown>,
  ) => Promise<Usage>;
}
