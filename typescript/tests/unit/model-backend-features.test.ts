import { Usage } from "@openai/agents";
import type { ModelProvider, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { makeReviewer } from "../../src/guardian/openai.js";
import { makeGuardian } from "../../src/guardian/review.js";
import type { PendingExecution } from "../../src/guardian/review.js";
import { mintIdleCompactionTokens } from "../../src/mint/idle-compaction.js";
import { makeMinter } from "../../src/mint/openai.js";
import type { makeOpenAIMinter } from "../../src/mint/openai.js";
import { makeOutcomeReviewer } from "../../src/mint/outcome-review-openai.js";
import { makeMintContinuationFixture } from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";
import { scriptedBackend } from "../support/scripted-backend.js";

// A backend without background compaction, cache diagnostics, effort changes that keep the cache,
// or a prewarm: the agents skip each, and send the review's effort in the intent instead.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const openAIOnly = /compaction_trigger|configuration_update|prompt_cache|prewarm/u;

const response = (id: string, output: ModelResponse["output"], inputTokens = 1) => ({
  responseId: id,
  usage: new Usage({ requests: 1, inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 }),
  output,
});
const call = (name: string, input: object) => ({
  type: "function_call" as const,
  name,
  callId: name,
  arguments: JSON.stringify({ ...input, intent: `Synthetic ${name} purpose` }),
  status: "completed" as const,
});

it("mints on a backend with every feature off", async () => {
  const scripted = scriptedBackend({ features: false, prewarm: false });
  const fixture = makeMintContinuationFixture(
    cleanups,
    portableJobSession,
    (...options: Parameters<typeof makeOpenAIMinter>) => makeMinter(scripted.backend, ...options),
  );
  const execute = call("execute", {
    purpose: "example",
    target: "pureFiles",
    entrypoint: "src/tool.ts",
    fixtureRefs: [],
    caseFilter: [],
    maxWorkers: 1,
    timeoutSeconds: 30,
  });
  const finish = call("finish_build", {
    entrypoint: "src/tool.ts",
    executionId: "execution_one",
    metadata: { name: "read_public", description: "Read public data" },
    coverage: "One actual example.",
  });
  // Past the idle compaction's watermark, where an OpenAI build would compact in the background.
  const f = await fixture((_request, index) =>
    index === 0
      ? response("resp_one", [execute], mintIdleCompactionTokens + 1_000)
      : response("resp_two", [finish]),
  );
  expect(await f.run()).toMatchObject({ build: "published" });

  expect(scripted.calls).toHaveLength(2);
  for (const { intent, request } of scripted.calls) {
    expect(intent.cache?.compareWith).toBeUndefined();
    expect(JSON.stringify(request)).not.toMatch(openAIOnly);
  }
});

it("reviews on a backend with every feature off, its effort in the intent", async () => {
  const scripted = scriptedBackend({ features: false, prewarm: false });
  const allow = {
    type: "message" as const,
    role: "assistant" as const,
    status: "completed" as const,
    content: [
      {
        type: "output_text" as const,
        text: JSON.stringify({ outcome: "allow", rationale: "Synthetic", action: "read" }),
      },
    ],
  };
  let calls = 0;
  // Each review is past Guardian's threshold, where an OpenAI session would compact first.
  const modelProvider: ModelProvider = {
    getModel: () => ({
      getResponse: () => Promise.resolve(response(`resp_${++calls}`, [allow], 239_900)),
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  };
  const pending: PendingExecution = {
    invocationId: "mint_features",
    attemptId: "attempt_one",
    entrypoint: "operation/operation.mjs",
    screenedIntent: "Read the listed opening hours",
    screenedInput: "{}",
    screenedObservations: "Synthetic fixture",
    accountScope: "account_one",
    allowedOrigins: ["https://hours.example.test"],
    allowedEffects: ["read"],
  };
  const quick = { ...pending, screenedInput: '{"quick":true}' };
  const reviewer = makeReviewer(scripted.backend, "Policy {{ tenant_policy_config }}", false, {
    executionEnvironment: nativeExecutionEnvironment,
    modelProvider,
    specialize: (turn) => (turn.pending === quick ? { reasoningEffort: "low" } : {}),
  });
  expect(await Effect.runPromise(reviewer.prewarm())).toMatchObject({ inputTokens: 0 });
  const guardian = makeGuardian(reviewer, undefined, {});
  const read = () => Effect.succeed("export default 1");
  for (const review of [pending, quick, pending])
    await Effect.runPromise(guardian.review(review, read));
  const outcomes = makeOutcomeReviewer(scripted.backend, { modelProvider });
  expect(await Effect.runPromise(outcomes.prewarm())).toMatchObject({ inputTokens: 0 });

  expect(scripted.calls.map(({ intent }) => intent.effort)).toStrictEqual([
    "medium",
    "low",
    "medium",
  ]);
  for (const { intent, request } of scripted.calls) {
    expect(intent.cache?.compareWith).toBeUndefined();
    expect(JSON.stringify(request)).not.toMatch(openAIOnly);
  }
});
