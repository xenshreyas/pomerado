import type { ModelRequest } from "@openai/agents";
import { StaticCompactionPolicy, compaction } from "@openai/agents/sandbox";
import type { ModelBackend } from "../backend.js";
import { lunaModel, solModel } from "../models.js";
import {
  withAllowedTools,
  withCacheComparison,
  withCachedPrefix,
  withPromptCache,
} from "../prompt-cache.js";
import { withReasoningContinuity } from "../reasoning-settings.js";

/** Input-token threshold for server-side compaction, the backstop behind the background one.
 * Set explicitly because the pinned SDK's context-window table has no GPT-6.1 entry and would
 * silently fall back; 268K also stays below GPT-6's 272K long-context pricing threshold, where
 * the input price doubles. */
export const mintCompactionThresholdTokens = 268_000;
export const mintCompaction = (): ReturnType<typeof compaction> =>
  compaction({ policy: new StaticCompactionPolicy(mintCompactionThresholdTokens) });

/**
 * The prompt-cache lifetime of the minter's static prefix: the instructions and the host's
 * static context, which every job of a release shares. The rest of the conversation uses the
 * implicit breakpoint at the default 30 minutes.
 */
const staticPrefixTtl = "12h";

/**
 * The Responses API, through whatever provider the Runner resolved. It shapes the minter's
 * requests; Guardian and the outcome reviewer still shape their own.
 */
export const openAIBackend = (): ModelBackend => ({
  model: (role) => (role === "minter" ? solModel : lunaModel),
  agent: (_role, intent) => ({
    // Summaries and encrypted reasoning continuity are always on; absence of a
    // summary is recorded per response. Reasoning from earlier turns stays rendered
    // after a continuation or host notice, so the cached prompt is never rewritten
    // from the first earlier reasoning item; the applied context is recorded per call.
    // The static prefix carries its own 12-hour breakpoint (withCachedPrefix); the rest of
    // the conversation is cached at the implicit breakpoint.
    modelSettings: withPromptCache(
      withReasoningContinuity({
        parallelToolCalls: intent.parallelToolCalls,
        reasoning: { effort: intent.effort, context: "all_turns" },
      }),
      {
        mode: "implicit",
        ...(intent.prewarm ? { prewarm: true } : {}),
        ...(intent.cache?.key === undefined ? {} : { key: intent.cache.key }),
      },
    ),
    // The minter's threshold is the one mintCompaction holds.
    capabilities: intent.compactAtTokens === undefined ? [] : [mintCompaction()],
  }),
  provider: (_role, intentOf, sdkProvider) => {
    /**
     * What every request sends, the background compaction's included: the instructions and
     * the host's static context lead as one developer message ending at a 12-hour cache
     * breakpoint, shared by every job of the release, ahead of everything else, a
     * compaction item included; and a build turn may call only the tools it offers.
     */
    const layout = (request: ModelRequest): ModelRequest => {
      const intent = intentOf(request);
      const prefixed = withCachedPrefix(request, intent.staticContext ?? [], staticPrefixTtl);
      // A prewarm sends the static prefix alone; which tools may run is no part of it.
      if (intent.prewarm) return { ...prefixed, input: prefixed.input.slice(0, 1) };
      // After the run's first turn, each request asks the provider to compare its cache
      // reuse with the last turn's response (prompt_cache_diagnostics).
      const lastResponseId = intent.cache?.compareWith;
      const compared =
        lastResponseId === undefined
          ? prefixed
          : withCacheComparison(prefixed, lastResponseId);
      const offered = intent.offeredTools;
      return offered === undefined
        ? compared
        : withAllowedTools(compared, (name) => offered.includes(name));
    };
    return {
      getModel: async (name) => {
        const model = await sdkProvider.getModel(name);
        return {
          getResponse: (request) => model.getResponse(layout(request)),
          getStreamedResponse: (request) => model.getStreamedResponse(layout(request)),
        };
      },
    };
  },
});
