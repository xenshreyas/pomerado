import { Effect } from "effect";
import { it } from "vitest";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { makeGuardian } from "../../src/guardian/review.js";
import type { PendingExecution } from "../../src/guardian/review.js";
import { makeOpenAIOutcomeReviewer } from "../../src/mint/outcome-review-openai.js";
import { expectGolden, goldenProvider } from "../support/golden-requests.js";
import type { Body, Reply } from "../support/golden-requests.js";

// Every request Guardian and the outcome reviewer send, in full: a change to how they shape one
// shows in its fixture.

const pending: PendingExecution = {
  invocationId: "mint_golden",
  attemptId: "attempt_one",
  entrypoint: "operation/operation.mjs",
  screenedIntent: "Read the listed opening hours",
  screenedInput: "{}",
  screenedObservations: "Synthetic fixture",
  accountScope: "account_one",
  allowedOrigins: ["https://hours.example.test"],
  allowedEffects: ["read"],
};
const quick: PendingExecution = { ...pending, screenedInput: '{"quick":true}' };
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

const allow = {
  type: "message",
  id: "msg_allow",
  role: "assistant",
  status: "completed",
  content: [
    {
      type: "output_text",
      text: JSON.stringify({ outcome: "allow", rationale: "Synthetic decision", action: "read" }),
      annotations: [],
    },
  ],
};
const read = {
  type: "function_call",
  id: "fc_read",
  call_id: "read",
  name: "read_source",
  arguments: JSON.stringify({ path: pending.entrypoint, offset: 0, match: null, paths: null }),
  status: "completed",
};
const compacted = (id: string) => ({ type: "compaction", id, encrypted_content: `opaque-${id}` });
const isTrigger = (body: Body) =>
  (body["input"] as { type?: string }[]).at(-1)?.type === "compaction_trigger";
/** A size just below the threshold, so the next review's request reaches it. */
const nearThreshold = { input_tokens: 239_900, output_tokens: 1, total_tokens: 1 };

/** A session of execution reviews, the quick ones at low effort, over `reply`. */
const session = async (reviews: readonly PendingExecution[], reply: (body: Body) => Reply) => {
  const wire = goldenProvider(reply);
  const guardian = makeGuardian(
    makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, {
      executionEnvironment: nativeExecutionEnvironment,
      modelProvider: wire.provider,
      specialize: (turn) =>
        turn.pending.screenedInput === quick.screenedInput ? { reasoningEffort: "low" } : {},
    }),
    undefined,
    {},
  );
  await Effect.runPromise(
    Effect.forEach(reviews, (review) => guardian.review(review, readCurrent)),
  );
  return wire.requests;
};

it("sends a Guardian session's requests across an effort change and a compaction", async () => {
  const replies: Reply[] = [
    { output: [allow] },
    { output: [allow], usage: nearThreshold },
    // The session compacts before this review's request, which takes the source out of view.
    { output: [read] },
    { output: [allow] },
    { output: [allow] },
  ];
  let turn = 0;
  const requests = await session([pending, quick, quick, pending], (body) =>
    isTrigger(body) ? { output: [compacted("cmp_session")] } : (replies[turn++] ?? {}),
  );
  expectGolden("guardian-session", requests);
});

it("keeps the provider's compaction as the backstop when the session's is refused", async () => {
  const replies: Reply[] = [
    { output: [allow], usage: nearThreshold },
    // The provider compacts the crossing request, which takes the review's request out of view,
    // so the model reads the source again.
    { output: [compacted("cmp_provider"), read] },
    { output: [allow] },
  ];
  let turn = 0;
  const requests = await session([quick, quick], (body) =>
    isTrigger(body) ? { status: 400 } : (replies[turn++] ?? {}),
  );
  expectGolden("guardian-backstop", requests);
});

it("sends Guardian's prewarm under the host's cache key", async () => {
  const wire = goldenProvider(() => ({}));
  await Effect.runPromise(
    makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, {
      executionEnvironment: nativeExecutionEnvironment,
      modelProvider: wire.provider,
      promptCacheKey: "synthetic-environment",
    }).prewarm(),
  );
  expectGolden("guardian-prewarm", wire.requests);
});

it("sends the outcome reviewer's prewarm and a turn", async () => {
  const wire = goldenProvider(() => ({
    output: [
      {
        type: "message",
        id: "msg_turn",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Nothing to assess.", annotations: [] }],
      },
    ],
  }));
  const model = makeOpenAIOutcomeReviewer({
    modelProvider: wire.provider,
    promptCacheKey: "synthetic-environment",
  });
  const unused = () => Effect.die(new Error("No tool call is scripted"));
  await Effect.runPromise(model.prewarm());
  await Effect.runPromise(
    model.turn({
      input: "First synthetic wake",
      final: false,
      conversation: { initial: undefined, save: () => Effect.void },
      tools: {
        searchHistory: unused,
        readHistory: unused,
        listRecords: unused,
        readRecord: unused,
        readTask: unused,
        submitAssessment: unused,
        requestObservation: unused,
      },
    }),
  );
  expectGolden("outcome-reviewer", wire.requests);
});
