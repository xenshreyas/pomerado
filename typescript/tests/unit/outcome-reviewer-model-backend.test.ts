import { Usage } from "@openai/agents";
import type { ModelProvider, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { guardianCompactionTokens } from "../../src/guardian/session.js";
import type { GuardianSessionSnapshot } from "../../src/guardian/session.js";
import { makeOutcomeReviewer } from "../../src/mint/outcome-review-openai.js";
import { scriptedBackend } from "../support/scripted-backend.js";

const done = (responseId: string): ModelResponse => ({
  responseId,
  usage: new Usage({ requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Nothing to assess." }],
    },
  ],
});
/** Ends each turn at once. */
const scriptedModel = (): ModelProvider => {
  let calls = 0;
  return {
    getModel: () => ({
      getResponse: () => Promise.resolve(done(`resp_${++calls}`)),
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  };
};
const unused = () => Effect.die(new Error("No tool call is scripted"));
const tools = {
  searchHistory: unused,
  readHistory: unused,
  listRecords: unused,
  readRecord: unused,
  readTask: unused,
  submitAssessment: unused,
  requestObservation: unused,
};

it("hands the outcome reviewer's needs to its backend, which alone shapes the requests", async () => {
  const scripted = scriptedBackend();
  const model = makeOutcomeReviewer(scripted.backend, {
    modelProvider: scriptedModel(),
    promptCacheKey: "synthetic-environment",
  });
  await Effect.runPromise(model.prewarm());
  // The second turn continues the conversation the first saved.
  let saved: GuardianSessionSnapshot | undefined;
  for (const input of ["First synthetic wake", "Second synthetic wake"])
    await Effect.runPromise(
      model.turn({
        input,
        final: false,
        conversation: {
          initial: saved,
          save: (snapshot) =>
            Effect.sync(() => {
              saved = snapshot;
            }),
        },
        tools,
      }),
    );

  const [instructions] = scripted.agents[0]?.instructionParts ?? [];
  expect(instructions).toContain("outcome reviewer");
  const intent = {
    effort: "medium",
    continuity: true,
    parallelToolCalls: false,
    cache: { key: "synthetic-environment" },
    instructionParts: [instructions],
    compactAtTokens: guardianCompactionTokens,
  };
  expect(scripted.agents).toStrictEqual([{ ...intent, prewarm: true }, intent, intent]);
  // The second turn continues the conversation, so it compares its cache with the first's.
  expect(scripted.calls.map(({ model, intent }) => ({ model, intent }))).toStrictEqual([
    { model: "scripted-outcome_reviewer", intent: { ...intent, prewarm: true } },
    { model: "scripted-outcome_reviewer", intent },
    {
      model: "scripted-outcome_reviewer",
      intent: { ...intent, cache: { ...intent.cache, compareWith: "resp_2" } },
    },
  ]);
  // Each request reaches the provider as the SDK built it, with none of OpenAI's shaping.
  for (const { request } of scripted.calls) {
    expect(request.systemInstructions).toBe(instructions);
    expect(JSON.stringify(request)).not.toMatch(
      /"role":"developer"|prompt_cache|context_management|encrypted_content/u,
    );
  }
});
