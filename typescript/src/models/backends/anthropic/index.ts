import type Anthropic from "@anthropic-ai/sdk";
import type { ModelBackend } from "../../backend.js";
import { claudeMinterModel, claudeReviewerModel } from "../../models.js";
import { classifyAnthropicFailure } from "./failure.js";
import { makeAnthropicModel } from "./model.js";

export { ModelInputTooLarge, ModelOutputTruncated, ModelRefusal } from "./failure.js";

export interface AnthropicBackendOptions {
  /**
   * The client every request goes through. Without one, the backend loads `@anthropic-ai/sdk`
   * on its first request and makes a client that reads its credentials from the environment.
   */
  readonly client?: Anthropic;
}

/**
 * The Claude Messages API. A host's own provider for a role, when it sets one, is used as it is:
 * it already answers the SDK's requests, and Claude's shaping lives in this backend's models.
 * Version 1 has no background compaction, cache diagnostics, effort change that keeps the cache
 * or prewarm, so its callers skip them: a conversation compacts on the server at its threshold.
 */
export const anthropicBackend = (options: AnthropicBackendOptions = {}): ModelBackend => {
  let client: Promise<Anthropic> | undefined;
  const clientOf = () =>
    (client ??=
      options.client === undefined
        ? import("@anthropic-ai/sdk").then(({ default: Client }) => new Client())
        : Promise.resolve(options.client));
  const model: ModelBackend["model"] = (role) =>
    role === "minter" ? claudeMinterModel : claudeReviewerModel;
  return {
    id: "anthropic",
    model,
    // Effort, continuity and compaction travel in each request's intent; the SDK's compaction
    // capability would send OpenAI's context management.
    agent: () => ({ modelSettings: {}, capabilities: [] }),
    provider: (role, intentOf, base) =>
      base ?? {
        getModel: async (name) =>
          makeAnthropicModel({ client: await clientOf(), model: name ?? model(role), intentOf }),
      },
    features: {
      backgroundCompaction: false,
      cacheDiagnostics: false,
      effortChangeKeepsCache: false,
      noteAfterToolResults: true,
    },
    classify: classifyAnthropicFailure,
  };
};
