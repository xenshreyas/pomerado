import { Usage } from "@openai/agents";
import type { ModelResponse } from "@openai/agents";
import { afterEach, expect, it } from "vitest";
import { makeMinter, mintCompactionThresholdTokens } from "../../src/mint/openai.js";
import type { makeOpenAIMinter } from "../../src/mint/openai.js";
import { makeMintContinuationFixture } from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";
import { scriptedBackend } from "../support/scripted-backend.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const call = (responseId: string, name: string, input: object): ModelResponse => ({
  responseId,
  usage: new Usage({ requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
  output: [
    {
      type: "function_call",
      name,
      callId: name,
      arguments: JSON.stringify({ ...input, intent: `Synthetic ${name} purpose` }),
      status: "completed",
    },
  ],
});

it("hands a build turn's needs to its backend, which alone shapes the requests", async () => {
  const scripted = scriptedBackend();
  const fixture = makeMintContinuationFixture(
    cleanups,
    portableJobSession,
    (...options: Parameters<typeof makeOpenAIMinter>) => makeMinter(scripted.backend, ...options),
  );
  const f = await fixture(
    (_request, index) =>
      index === 0
        ? call("resp_example", "execute", {
            purpose: "example",
            target: "pureFiles",
            entrypoint: "src/tool.ts",
            fixtureRefs: [],
            caseFilter: [],
            maxWorkers: 1,
            timeoutSeconds: 30,
          })
        : call("resp_finish", "finish_build", {
            entrypoint: "src/tool.ts",
            executionId: "execution_one",
            metadata: { name: "read_public", description: "Read public data" },
            coverage: "One actual example.",
          }),
    { staticContext: ["Synthetic static reference."], promptCacheKey: "synthetic-environment" },
  );
  expect(await f.run()).toMatchObject({ build: "published" });

  const intent = {
    effort: "medium",
    continuity: true,
    parallelToolCalls: true,
    cache: { key: "synthetic-environment" },
    staticContext: ["Synthetic static reference."],
    compactAtTokens: mintCompactionThresholdTokens,
  };
  expect(scripted.agents).toStrictEqual([intent]);
  // The host tools the fixture's build offers, then the workspace's own.
  const offeredTools = [
    "read_source",
    "execute",
    "finish_build",
    "report_blocked",
    "request_input",
    "check_signed_in_marker",
    "apply_patch",
    "exec_command",
  ];
  expect(scripted.calls.map(({ model, intent }) => ({ model, intent }))).toStrictEqual([
    { model: "scripted-minter", intent: { ...intent, offeredTools } },
    {
      model: "scripted-minter",
      intent: { ...intent, cache: { ...intent.cache, compareWith: "resp_example" }, offeredTools },
    },
  ]);
  // Each request reaches the provider as the SDK built it, with none of OpenAI's shaping.
  for (const { request } of scripted.calls) {
    expect(request.systemInstructions).toContain("Synthetic instructions.");
    expect(request.modelSettings).toEqual({ parallelToolCalls: true, providerData: {} });
    expect(JSON.stringify(request)).not.toMatch(
      /"role":"developer"|prompt_cache|allowed_tools|context_management|encrypted_content/u,
    );
  }
});
