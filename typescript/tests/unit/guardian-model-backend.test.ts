import { Usage } from "@openai/agents";
import type { ModelProvider, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { makeReviewer } from "../../src/guardian/openai.js";
import { makeGuardian } from "../../src/guardian/review.js";
import type { PendingExecution } from "../../src/guardian/review.js";
import { guardianCompactionTokens } from "../../src/guardian/session.js";
import { scriptedBackend } from "../support/scripted-backend.js";

const pending: PendingExecution = {
  invocationId: "mint_backend",
  attemptId: "attempt_one",
  entrypoint: "operation/operation.mjs",
  screenedIntent: "Read the listed opening hours",
  screenedInput: "{}",
  screenedObservations: "Synthetic fixture",
  accountScope: "account_one",
  allowedOrigins: ["https://hours.example.test"],
  allowedEffects: ["read"],
};
const readCurrent = () =>
  Effect.succeed(
    JSON.stringify({
      kind: "untrusted_source",
      path: pending.entrypoint,
      byteOffset: 0,
      source: "export default 1",
      nextOffset: 16,
      hasMore: false,
    }),
  );
const usage = () => new Usage({ requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 });
const read: ModelResponse = {
  usage: usage(),
  output: [
    {
      type: "function_call",
      name: "read_source",
      callId: "read",
      arguments: JSON.stringify({ path: pending.entrypoint, offset: 0, match: null, paths: null }),
      status: "completed",
    },
  ],
};
const allow: ModelResponse = {
  usage: usage(),
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: JSON.stringify({
            outcome: "allow",
            rationale: "Synthetic decision",
            action: "read",
          }),
        },
      ],
    },
  ],
};
/** Reads the entrypoint, then allows, for each review. */
const scriptedModel = (): ModelProvider => {
  let calls = 0;
  return {
    getModel: () => ({
      getResponse: () => Promise.resolve(calls++ % 2 === 0 ? read : allow),
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  };
};

it.each([
  ["a review", undefined, { continuity: false }],
  ["a session's review", {}, { continuity: true, compactAtTokens: guardianCompactionTokens }],
] as const)("hands %s's needs to its backend, which alone shapes the requests", async (
  _name,
  continuity,
  needs,
) => {
  const scripted = scriptedBackend();
  const policy = "Synthetic policy {{ tenant_policy_config }}";
  const reviewer = makeReviewer(scripted.backend, policy, false, {
    executionEnvironment: nativeExecutionEnvironment,
    modelProvider: scriptedModel(),
    promptCacheKey: "synthetic-environment",
  });
  // A Guardian with session options keeps one conversation across its reviews.
  const guardian = makeGuardian(reviewer, undefined, continuity);
  expect(await Effect.runPromise(guardian.review(pending, readCurrent))).toMatchObject({
    decision: { outcome: "allow" },
  });

  const [shared, build] = scripted.calls[0]?.intent.instructionParts ?? [];
  expect(shared).toContain("Synthetic policy");
  expect(build).toContain("Read the listed opening hours");
  const intent = {
    effort: "medium",
    parallelToolCalls: true,
    cache: { key: "synthetic-environment" },
    instructionParts: [shared, build],
    ...needs,
  };
  expect(scripted.agents).toStrictEqual([intent]);
  expect(scripted.calls.map(({ model, intent }) => ({ model, intent }))).toStrictEqual([
    { model: "scripted-guardian", intent },
    { model: "scripted-guardian", intent },
  ]);
  // Each request reaches the provider as the SDK built it, with none of OpenAI's shaping.
  for (const { request } of scripted.calls) {
    expect(request.systemInstructions).toBe(`${shared}\n\n${build}`);
    expect(JSON.stringify(request)).not.toMatch(
      /"role":"developer"|prompt_cache|context_management|encrypted_content|configuration_update/u,
    );
  }
});
