import { APIError } from "openai";
import type { ModelProvider } from "@openai/agents";
import { Cause, Effect, Exit, Option } from "effect";
import { afterEach, expect, it } from "vitest";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { makeReviewer } from "../../src/guardian/openai.js";
import { makeGuardian } from "../../src/guardian/review.js";
import { MintFailure } from "../../src/mint/contracts.js";
import { makeMinter, makeOpenAIMinter } from "../../src/mint/openai.js";
import { reviewFailureOf } from "../../src/mint/review-context.js";
import type { ModelFailureKind } from "../../src/models/backend.js";
import { openAIBackend } from "../../src/models/backends/openai.js";
import { failureDetail } from "../../src/runtime/failure-detail.js";
import { mcpFailureMessage } from "../../src/standalone/mcp-jobs.js";
import { makeMintContinuationFixture } from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";
import { scriptedBackend } from "../support/scripted-backend.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const kinds: readonly ModelFailureKind[] = [
  "quota_exhausted",
  "authentication",
  "model_unavailable",
  "input_too_large",
  "refused",
  "backend_configuration",
];
/** A provider whose every call fails as a server error would, which the generic rules retry. */
const failing = () => {
  let calls = 0;
  const provider: ModelProvider = {
    getModel: () => ({
      getResponse: () => {
        calls++;
        return Promise.reject(Object.assign(new Error("Synthetic failure"), { status: 503 }));
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  };
  return { provider, calls: () => calls };
};
const classifyAs = (kind: ModelFailureKind) => (error: unknown) =>
  error instanceof Error && error.message === "Synthetic failure" ? kind : undefined;
/** The MCP message for a mint's failure that records its model failure as `kind`. */
const messageFor = (kind: ModelFailureKind | undefined) =>
  mcpFailureMessage(
    Cause.fail(
      new MintFailure({
        code: "Unavailable",
        ...(kind === undefined
          ? {}
          : {
              failureDetail: failureDetail("provider_failed", {
                operation: "model.getResponse",
                context: { modelFailureKind: kind },
              }),
            }),
      }),
    ),
  );

it("names OpenAI's spent quota, rejected key and request over the context window", () => {
  const error = (status: number, code?: string) =>
    APIError.generate(status, { error: { message: "Synthetic", code } }, undefined, new Headers());
  const { classify } = openAIBackend();
  expect(classify(error(429, "insufficient_quota"))).toBe("quota_exhausted");
  expect(classify(error(401, "invalid_api_key"))).toBe("authentication");
  expect(classify(error(400, "context_length_exceeded"))).toBe("input_too_large");
  expect(classify(error(429))).toBeUndefined();
  expect(classify(error(500))).toBeUndefined();
});

it.each(kinds)("ends a mint at once on a failure its backend names %s", async (kind) => {
  const wire = failing();
  const { backend } = scriptedBackend({ classify: classifyAs(kind) });
  const minter = makeMinter(backend, wire.provider);
  let failure: MintFailure | undefined;
  const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);
  const f = await fixture(() => Promise.reject(new Error("Unused")), {
    model: {
      run: (turn) =>
        minter.run(turn).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              failure = error;
            }),
          ),
        ),
    },
  });
  await f.run();

  // The generic rules would retry a 503; the backend's kind is tried first.
  expect(wire.calls()).toBe(1);
  expect(failure?.modelOutage).toBe(
    kind === "quota_exhausted" || kind === "refused" ? kind : undefined,
  );
  if (kind !== "quota_exhausted")
    expect(failure?.failureDetail?.context).toMatchObject({ modelFailureKind: kind });
  // The MCP message names the kind the failure records, as for a provider error of that kind.
  expect(mcpFailureMessage(Cause.fail(failure))).toBe(messageFor(kind));
});

it("gives each kind its own MCP message", () => {
  const messages = kinds.map(messageFor);
  expect(new Set(messages).size).toBe(kinds.length);
  expect(messages).not.toContain(messageFor(undefined));
});

it.each([
  ["input_too_large", { code: "InputTooLarge" }],
  ["quota_exhausted", { code: "Unavailable", modelQuotaExhausted: true }],
  // A refusal keeps the outage's code, so a host that reads only codes sees no change.
  ["refused", { code: "Unavailable", modelRefused: true }],
] as const)("fails a review its backend names %s at once, with Guardian's own failure", async (
  kind,
  expected,
) => {
  const wire = failing();
  const reviewer = makeReviewer(
    scriptedBackend({ classify: classifyAs(kind) }).backend,
    "Synthetic policy {{ tenant_policy_config }}",
    false,
    { executionEnvironment: nativeExecutionEnvironment, modelProvider: wire.provider },
  );
  // An outage retry that would review again within the second.
  const retry = { delays: ["1 millis"], budget: "1 second" } as const;
  const exit = await Effect.runPromiseExit(
    makeGuardian({ ...reviewer, retry }).review(
      {
        invocationId: "mint_failure",
        attemptId: "attempt_one",
        entrypoint: "operation/operation.mjs",
        screenedIntent: "Read the listed opening hours",
        screenedInput: "{}",
        screenedObservations: "Synthetic fixture",
        accountScope: "account_one",
        allowedOrigins: ["https://hours.example.test"],
        allowedEffects: ["read"],
      },
      () => Effect.succeed("export default 1"),
    ),
  );
  const failure = Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.failureOption(exit.cause))
    : undefined;
  expect(failure).toMatchObject(expected);
  expect(wire.calls()).toBe(1);
  if (kind === "refused" && failure !== undefined) {
    // The minter ends the attempt on it as on its own model's refusal.
    expect(reviewFailureOf(failure).modelOutage).toBe("refused");
    expect(mcpFailureMessage(Cause.fail(failure))).toBe(messageFor("refused"));
  }
});
