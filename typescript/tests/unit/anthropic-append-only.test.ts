import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { makeReviewer } from "../../src/guardian/openai.js";
import { makeGuardian } from "../../src/guardian/review.js";
import type { GuardianSessionSnapshot } from "../../src/guardian/session.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { makeOutcomeReviewer } from "../../src/mint/outcome-review-openai.js";
import { anthropicBackend } from "../../src/models/backends/anthropic/index.js";
import { claudeClient, claudeStream } from "../support/anthropic-wire.js";
import {
  allow,
  claudeMint,
  compaction,
  edit,
  execute,
  finish,
  pending,
  quick,
  readCurrent,
  readSkill,
  toolUse,
} from "../support/claude-scripts.js";
import type { Block } from "../support/claude-scripts.js";
import { makeMintContinuationFixture, portableJobSession } from "../support/mint-fixtures.js";

// Claude binds each thinking block to the exact conversation before it, so every request must
// carry the one before it unchanged: a Pomerado edit to its history fails here.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

type Body = Record<string, unknown>;
/** A part of a request as its bytes, with the cache breakpoints, which bind nothing, removed. */
const bytes = (value: unknown) =>
  JSON.stringify(value, (key, inner: unknown) => (key === "cache_control" ? undefined : inner));
/** `before` as sent, which `after` starts with: an array's bytes without its closing bracket. */
const startsWith = (after: unknown, before: unknown) => {
  const prefix = bytes(before ?? []);
  return bytes(after ?? []).startsWith(Array.isArray(before) ? prefix.slice(0, -1) : prefix);
};

/**
 * Each request's system, tools and messages begin with the request before it, byte for byte,
 * except the messages of a request that follows a server compaction, which start from it.
 */
const expectAppendOnly = (bodies: readonly Body[], compactedBefore: readonly number[] = []) => {
  expect(bodies.length).toBeGreaterThan(1);
  for (const [index, body] of bodies.entries()) {
    const before = bodies[index - 1];
    if (before === undefined) continue;
    const parts = compactedBefore.includes(index)
      ? ["system", "tools"]
      : ["system", "tools", "messages"];
    for (const part of parts)
      expect(startsWith(body[part], before[part]), `request ${index}'s ${part}`).toBe(true);
  }
};

const thinking = (turn: number): Block => ({
  type: "thinking",
  thinking: `Plan step ${turn}`,
  signature: `sig_${turn}`,
});

it("keeps a whole mint's Claude conversation append-only, across a server compaction", async () => {
  const turns: Block[][] = [
    [thinking(0), readSkill],
    [thinking(1), { type: "text", text: "Editing the tool." }, edit],
    [thinking(2), execute()],
    // The server compacts this request: the next one starts from the compaction.
    [compaction, thinking(3), execute("execute_again")],
    [thinking(4), finish],
  ];
  const { result, bodies } = await claudeMint(fixture, turns);
  expect(result).toMatchObject({ build: "published" });
  expect(bodies).toHaveLength(turns.length);
  expectAppendOnly(bodies, [4]);
});

it("keeps a Guardian session's Claude conversation append-only across reviews", async () => {
  const read = toolUse("read_source", {
    path: pending.entrypoint,
    offset: 0,
    match: null,
    paths: null,
  });
  const replies = [
    allow,
    allow,
    claudeStream({ content: [thinking(2), read], stopReason: "tool_use" }),
    allow,
    allow,
  ];
  const wire = claudeClient((_body, index) => replies[index]);
  const guardian = makeGuardian(
    makeReviewer(
      anthropicBackend({ client: wire.client }),
      "Policy {{ tenant_policy_config }}",
      false,
      {
        executionEnvironment: nativeExecutionEnvironment,
        specialize: (turn) =>
          turn.pending.screenedInput === quick.screenedInput ? { reasoningEffort: "low" } : {},
      },
    ),
    undefined,
    {},
  );
  await Effect.runPromise(
    Effect.forEach([pending, quick, quick, pending], (review) =>
      guardian.review(review, readCurrent),
    ),
  );
  expectAppendOnly(wire.bodies);
});

it("keeps the outcome reviewer's Claude conversation append-only across turns, unprewarmed", async () => {
  const wire = claudeClient(() =>
    claudeStream({ content: [thinking(0), { type: "text", text: "Nothing to assess." }] }),
  );
  const model = makeOutcomeReviewer(anthropicBackend({ client: wire.client }), {});
  // Claude has no prewarm, so it sends nothing.
  await Effect.runPromise(model.prewarm());
  const unused = () => Effect.die(new Error("No tool call is scripted"));
  let saved: GuardianSessionSnapshot | undefined;
  const turn = (input: string) =>
    model.turn({
      input,
      final: false,
      conversation: {
        initial: saved,
        save: (snapshot) => Effect.sync(() => void (saved = snapshot)),
      },
      tools: {
        searchHistory: unused,
        readHistory: unused,
        listRecords: unused,
        readRecord: unused,
        readTask: unused,
        submitAssessment: unused,
        requestObservation: unused,
      },
    });
  await Effect.runPromise(turn("First synthetic wake"));
  await Effect.runPromise(turn("Second synthetic wake"));
  expect(wire.bodies).toHaveLength(2);
  expectAppendOnly(wire.bodies);
});
