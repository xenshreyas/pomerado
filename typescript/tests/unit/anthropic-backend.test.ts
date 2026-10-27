import { Effect } from "effect";
import type { ModelProvider } from "@openai/agents";
import { afterEach, expect, it } from "vitest";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { makeReviewer } from "../../src/guardian/openai.js";
import { makeGuardian } from "../../src/guardian/review.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { applyPatchTool } from "../../src/models/backends/anthropic/apply-patch.js";
import { anthropicBackend } from "../../src/models/backends/anthropic/index.js";
import { claudeClient } from "../support/anthropic-wire.js";
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
} from "../support/claude-scripts.js";
import type { Message } from "../support/claude-scripts.js";
import { makeMintContinuationFixture, portableJobSession } from "../support/mint-fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

it("mints on Claude, offering the SDK's native apply_patch as Claude's function tool", async () => {
  const { result, bodies } = await claudeMint(fixture, [[edit], [execute()], [finish]]);
  expect(result).toMatchObject({ build: "published" });
  // The SDK hands a model it does not know as Chat Completions its native apply_patch tool,
  // which only the backend's own definition describes this way.
  const tools = bodies[0]?.["tools"] as { name: string }[];
  expect(tools.find((tool) => tool.name === "apply_patch")).toStrictEqual(applyPatchTool);
  // The minter's effort, and none of OpenAI's settings, which the backend's agent leaves out.
  expect(bodies[0]?.["output_config"]).toStrictEqual({ effort: "medium" });
  for (const key of ["store", "include", "reasoning", "prompt_cache_key", "parallel_tool_calls"])
    expect(bodies[0]).not.toHaveProperty(key);
});

it("puts the note after a provider compaction at the end of the next user turn", async () => {
  const { bodies } = await claudeMint(fixture, [
    [readSkill],
    [compaction, execute()],
    [execute("execute_again")],
    [finish],
  ]);
  const compacted = bodies[2]?.["messages"] as Message[];
  expect(compacted[0]?.content.map((block) => block.type)).toStrictEqual([
    "compaction",
    "tool_use",
  ]);
  const types = compacted[1]?.content.map((block) => block.type);
  expect(types).toStrictEqual(["tool_result", "text"]);
  expect(compacted[1]?.content.at(-1)?.["text"]).toContain("core");
  // The next request sends the turn the same way, and adds its own after it.
  const next = bodies[3]?.["messages"] as Message[];
  expect(JSON.stringify(next.slice(0, 2))).toBe(JSON.stringify(compacted));
});

it("sends each Guardian review at its own effort", async () => {
  const wire = claudeClient(() => allow);
  const guardian = makeGuardian(
    makeReviewer(
      anthropicBackend({ client: wire.client }),
      "Synthetic policy {{ tenant_policy_config }}",
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
    Effect.forEach([pending, quick, pending], (review) => guardian.review(review, readCurrent)),
  );
  expect(wire.bodies.map((body) => body["output_config"])).toMatchObject(
    ["medium", "low", "medium"].map((effort) => ({ effort })),
  );
});

it("uses a host's provider for a role as it is", () => {
  const base: ModelProvider = { getModel: () => Promise.reject(new Error("Unused")) };
  expect(anthropicBackend().provider("guardian", () => ({}) as never, base)).toBe(base);
});
