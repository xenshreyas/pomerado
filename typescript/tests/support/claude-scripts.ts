import { Effect } from "effect";
import type { PendingExecution } from "../../src/guardian/review.js";
import { makeMinter } from "../../src/mint/openai.js";
import { anthropicBackend } from "../../src/models/backends/anthropic/index.js";
import { claudeClient, claudeStream } from "./anthropic-wire.js";
import type { makeMintContinuationFixture } from "./mint-fixtures.js";

// Scripted Claude turns for a mint and a Guardian session, as the Messages API streams them.

export type Block = { readonly type: string } & Record<string, unknown>;
export type Message = { readonly role: string; readonly content: readonly Block[] };
export const toolUse = (name: string, input: object, id = name): Block => ({
  type: "tool_use",
  id: `toolu_${id}`,
  name,
  input: { ...input, intent: `Synthetic ${name} purpose` },
});
export const readSkill = toolUse("read_source", {
  path: ".agents/core/SKILL.md",
  offset: null,
  limit: null,
  paths: null,
});
export const edit: Block = {
  type: "tool_use",
  id: "toolu_edit",
  name: "apply_patch",
  input: {
    operation: {
      type: "update_file",
      path: "src/tool.ts",
      diff: '@@\n-export default {};\n+export default { name: "read_public" };',
    },
  },
};
export const execute = (id = "execute") =>
  toolUse(
    "execute",
    {
      purpose: "example",
      target: "pureFiles",
      loginUrl: null,
      entrypoint: "src/tool.ts",
      fixtureRefs: [],
      caseFilter: [],
      maxWorkers: 1,
      timeoutSeconds: 30,
      testInput: null,
      signInStep: null,
      cardFillStep: null,
      exampleInput: null,
    },
    id,
  );
export const finish = toolUse("finish_build", {
  entrypoint: "src/tool.ts",
  executionId: "execution_one",
  metadata: { name: "read_public", description: "Read public data" },
  coverage: "One actual example.",
});
export const compaction: Block = {
  type: "compaction",
  content: "The minter read the skill.",
  encrypted_content: null,
};

/**
 * A scripted mint on Claude through `fixture`: each turn's content blocks, one response per
 * request, and every request's body.
 */
export const claudeMint = async (
  fixture: ReturnType<typeof makeMintContinuationFixture>,
  turns: readonly (readonly Block[])[],
) => {
  const wire = claudeClient((_body, index) => {
    const content = turns[index];
    return content && claudeStream({ content, stopReason: "tool_use" });
  });
  const f = await fixture(() => Promise.reject(new Error("Unused")), {
    model: makeMinter(anthropicBackend({ client: wire.client })),
  });
  return { result: await f.run(), bodies: wire.bodies };
};

export const pending: PendingExecution = {
  invocationId: "mint_claude",
  attemptId: "attempt_one",
  entrypoint: "operation/operation.mjs",
  screenedIntent: "Read the listed opening hours",
  screenedInput: "{}",
  screenedObservations: "Synthetic fixture",
  accountScope: "account_one",
  allowedOrigins: ["https://hours.example.test"],
  allowedEffects: ["read"],
};
export const quick: PendingExecution = { ...pending, screenedInput: '{"quick":true}' };
export const allow = claudeStream({
  content: [
    {
      type: "text",
      text: JSON.stringify({ outcome: "allow", rationale: "Synthetic decision", action: "read" }),
    },
  ],
});
export const readCurrent = () =>
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
