import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import type { MintDiagnostics } from "../../src/mint/diagnostics.js";
import { mintIdleCompactionTokens } from "../../src/mint/idle-compaction.js";
import { makeOpenAIMinter, prewarmMinterPrefix } from "../../src/mint/openai.js";
import { expectGolden, goldenProvider } from "../support/golden-requests.js";
import type { Body } from "../support/golden-requests.js";
import {
  makeMintContinuationFixture,
  portableJobSession,
  readAllow,
} from "../support/mint-fixtures.js";

// Every request the minter sends, in full: a change to how it shapes one shows in its fixture.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

const settings = {
  // The settings the continuation fixture gives each job.
  instructions: "Synthetic instructions.",
  skills: [
    {
      name: "core",
      description: "Synthetic test contract",
      content: "Publish through finish_build or request legitimate missing input.",
    },
  ],
  staticContext: ["Synthetic static reference."],
  promptCacheKey: "synthetic-environment",
};

const call = (name: string, args: object, callId = name) => ({
  type: "function_call",
  id: `fc_${callId}`,
  call_id: callId,
  name,
  arguments: JSON.stringify({ ...args, intent: `Synthetic ${name} purpose` }),
  status: "completed",
});
const execution = {
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
};
const finish = call("finish_build", {
  entrypoint: "src/tool.ts",
  executionId: "execution_one",
  metadata: { name: "read_public", description: "Read public data" },
  coverage: "One actual example.",
});
const compacted = (id: string) => ({ type: "compaction", id, encrypted_content: `opaque-${id}` });
const isTrigger = (body: Body) =>
  (body["input"] as { type?: string }[]).at(-1)?.type === "compaction_trigger";

it("sends a build's requests across an edit, an idle and a provider compaction", async () => {
  let ready!: () => void;
  const landed = new Promise<void>((resolve) => (ready = resolve));
  const record: MintDiagnostics["emit"] = (name, details) =>
    Effect.sync(() => {
      if (name === "mint.model" && Reflect.get(details as object, "state") === "ready") ready();
    });
  const skill = ".agents/core/SKILL.md";
  const turns = [
    // The skill read is what the notes after each compaction name.
    [
      { type: "reasoning", id: "rs_golden", summary: [], encrypted_content: "opaque-reasoning" },
      call("read_source", { path: skill, offset: null, limit: null, paths: null }),
    ],
    [
      {
        type: "apply_patch_call",
        id: "apc_golden",
        call_id: "edit",
        status: "completed",
        operation: {
          type: "update_file",
          path: "src/tool.ts",
          diff: '@@\n-export default {};\n+export default { name: "read_public" };',
        },
      },
    ],
    // Past the watermark: the minter compacts this request while the execution runs.
    [call("execute", execution)],
    // The provider compacts this request itself.
    [compacted("cmp_provider"), call("execute", execution, "execute_again")],
    [finish],
  ];
  let turn = 0;
  const wire = goldenProvider((body) =>
    isTrigger(body)
      ? { output: [compacted("cmp_idle")] }
      : {
          output: turns[turn++] ?? [],
          usage: {
            input_tokens: turn === 3 ? mintIdleCompactionTokens + 1_000 : 1,
            output_tokens: 1,
            total_tokens: 1,
          },
        },
  );
  const f = await fixture(() => Promise.reject(new Error("Unused")), {
    ...settings,
    model: makeOpenAIMinter(wire.provider),
    diagnostics: { emit: record, retainModelTranscript: record },
    // An execution ends once the compaction landed, so the next turn sends its window.
    reviewAndExecute: (_input, beforeDispatch = () => Effect.void) =>
      beforeDispatch(readAllow).pipe(
        Effect.zipRight(Effect.promise(() => landed)),
        Effect.as({
          executionId: "execution_one",
          status: "completed" as const,
          effect: "verified" as const,
          resultRef: "protected_result",
          observations: { value: "public" },
        }),
      ),
  });
  expect(await f.run()).toMatchObject({ build: "published" });
  expectGolden("mint-build", wire.requests);
});

it("sends the prewarm of the minter's static prefix", async () => {
  const wire = goldenProvider(() => ({}));
  await Effect.runPromise(prewarmMinterPrefix(settings, wire.provider));
  expectGolden("mint-prewarm", wire.requests);
});
