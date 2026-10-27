import { test, expect } from "@playwright/test";
import { anthropicBackend } from "../../src/models/backends/anthropic/index.js";
import { claudeMinterModel } from "../../src/models/models.js";
import { claudeClient, claudeStream } from "../support/anthropic-wire.js";
import type { Block, Message } from "../support/claude-scripts.js";
import { execution, html, recordingGuardian, startSite } from "./guardian-context-fixture.js";
import { mint } from "./standalone-mint-fixture.js";

const tool = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"read_heading",input:Schema.Struct({}),output:Schema.Struct({heading:Schema.NonEmptyTrimmedString})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"return await page.locator('h1').textContent();",timeout_sec:5});
  if(!response.success) throw new Error(String(response.error));
  return {heading:response.result};
});`;

/** The JSON a request's tool result for `id` holds. */
const resultOf = (body: Record<string, unknown>, id: string) => {
  const blocks = (body["messages"] as Message[]).flatMap((message) => message.content);
  const result = blocks.find((block) => block["tool_use_id"] === id)?.["content"];
  const text = typeof result === "string" ? result : (result as Block[])[0]?.["text"];
  return JSON.parse(String(text)) as Record<string, unknown>;
};

test("createPomerado mints a read integration on the Claude backend", async () => {
  test.setTimeout(60_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Fixture</title><h1>Opening hours</h1>"),
  );
  const turns: ((body: Record<string, unknown>) => Block[])[] = [
    () => [
      { type: "thinking", thinking: "Write the read.", signature: "sig_write" },
      {
        type: "tool_use",
        id: "toolu_write",
        name: "apply_patch",
        input: {
          operation: {
            type: "create_file",
            path: "src/tool.mjs",
            diff: `${tool
              .split("\n")
              .map((line) => `+${line}`)
              .join("\n")}\n`,
          },
        },
      },
    ],
    () => [
      {
        type: "tool_use",
        id: "toolu_example",
        name: "execute",
        input: execution("example", "src/tool.mjs"),
      },
    ],
    (body) => [
      {
        type: "tool_use",
        id: "toolu_finish",
        name: "finish_build",
        input: {
          intent: "Return the page's heading",
          entrypoint: "src/tool.mjs",
          executionId: resultOf(body, "toolu_example")["executionId"],
          metadata: { name: "read_heading", description: "Read the page's heading" },
          coverage: "One live example",
        },
      },
    ],
  ];
  const wire = claudeClient((body, index) => {
    const content = turns[index]?.(body) ?? [{ type: "text", text: "Done." }];
    return claudeStream({ content, stopReason: "tool_use" });
  });
  try {
    const { built } = await mint({
      effect: "read",
      url: site.url,
      turns: [],
      modelBackend: anthropicBackend({ client: wire.client }),
      guardian: recordingGuardian(),
    });
    expect(built.build, JSON.stringify(built)).toBe("published");
    expect(wire.bodies.map((body) => body["model"])).toStrictEqual(
      turns.map(() => claudeMinterModel),
    );
  } finally {
    await site.close();
  }
});
