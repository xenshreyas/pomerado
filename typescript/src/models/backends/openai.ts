import { Runner } from "@openai/agents";
import type { ModelProvider, ModelRequest } from "@openai/agents";
import { StaticCompactionPolicy, compaction } from "@openai/agents/sandbox";
import { guardianReviewSettings } from "../../guardian/openai-input.js";
import { guardianCompaction } from "../../guardian/session.js";
import type { AgentShaping, ModelBackend, ModelIntent, ModelRole } from "../backend.js";
import {
  instructionsAsMessages,
  prewarmInstructions,
  withCacheComparison as withConversationComparison,
} from "../cached-instructions.js";
import type { InstructionsMessage } from "../cached-instructions.js";
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

type IntentOf = (request: ModelRequest) => ModelIntent;

const minterAgent = (intent: ModelIntent): AgentShaping => ({
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
});

const minterProvider = (intentOf: IntentOf, sdkProvider: ModelProvider): ModelProvider => {
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
};

/**
 * The instructions as developer messages: the shared part, the same under every build, ends in a
 * 12-hour cache breakpoint, so every build reads it from the cache.
 */
const instructionMessages = (intent: ModelIntent): readonly InstructionsMessage[] =>
  (intent.instructionParts ?? []).map((text, index) =>
    index === 0 ? { text, breakpoint: "12h" } : { text },
  );

const guardianAgent = (intent: ModelIntent): AgentShaping => ({
  // The request's effort stays the default whatever the review's, so its cached prefix holds:
  // a review at another effort carries a configuration update, which Guardian writes. A
  // continuing conversation compacts at Guardian's threshold, the intent's compactAtTokens.
  modelSettings: guardianReviewSettings(intent.continuity, intent.cache?.key),
  capabilities: [],
});

const outcomeReviewerAgent = (intent: ModelIntent): AgentShaping => ({
  modelSettings: withReasoningContinuity({
    store: false,
    reasoning: { effort: intent.effort, context: "all_turns" },
    // The instructions are cached for 12 hours, the conversation after them implicitly.
    promptCacheOptions: { mode: "implicit" },
    parallelToolCalls: intent.parallelToolCalls,
    // Its conversation compacts at Guardian's threshold, the intent's compactAtTokens.
    providerData: {
      ...guardianCompaction().samplingParams({ model: lunaModel }),
      ...(intent.cache?.key === undefined ? {} : { prompt_cache_key: intent.cache.key }),
    },
  }),
  capabilities: [],
});

/** The provider with `shape` applied to every request it sends. */
const shapingRequests = (
  provider: ModelProvider,
  shape: (request: ModelRequest) => ModelRequest,
): ModelProvider => ({
  getModel: async (name) => {
    const model = await provider.getModel(name);
    return {
      ...model,
      getResponse: (request) => model.getResponse(shape(request)),
      getStreamedResponse: (request) => model.getStreamedResponse(shape(request)),
    };
  },
});

/**
 * The instructions travel as developer messages, the shared ones ending in a cache breakpoint,
 * right above the model, so every observer still sees them as instructions. Each request of a
 * continuing conversation compares its prompt cache with the conversation's latest response.
 */
const instructionsProvider = (intentOf: IntentOf, base: ModelProvider): ModelProvider =>
  shapingRequests(
    instructionsAsMessages(base, (request) => instructionMessages(intentOf(request))),
    (request) => withConversationComparison(request, intentOf(request).cache?.compareWith),
  );

/**
 * The SDK's default provider, resolved when a model is first asked for, as a Runner without a
 * provider resolves it: the SDK exports no other way to reach it.
 */
const sdkDefault = (): ModelProvider => new Runner().config.modelProvider;

const provider: ModelBackend["provider"] = (role, intentOf, base = sdkDefault()) =>
  role === "minter" ? minterProvider(intentOf, base) : instructionsProvider(intentOf, base);

const agents: Record<ModelRole, (intent: ModelIntent) => AgentShaping> = {
  minter: minterAgent,
  guardian: guardianAgent,
  outcome_reviewer: outcomeReviewerAgent,
};

/** The Responses API, through whatever provider the Runner resolved. */
export const openAIBackend = (): ModelBackend => ({
  model: (role) => (role === "minter" ? solModel : lunaModel),
  agent: (role, intent) => agents[role](intent),
  provider,
  features: { backgroundCompaction: true, cacheDiagnostics: true, effortChangeKeepsCache: true },
  // The prewarm keeps only the instructions' messages: the minter prewarms through its own
  // request's layout instead (`intent.prewarm`).
  prewarm: (role, intent, base = sdkDefault(), run) =>
    prewarmInstructions(base, intent.instructionParts?.length ?? 0, (prewarming) =>
      run(provider(role, () => intent, prewarming)),
    ),
});
