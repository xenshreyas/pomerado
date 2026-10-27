import type { AgentInputItem } from "@openai/agents";
import { describe, expect, it } from "vitest";
import {
  claudeModel,
  claudeStream,
  claudeWire,
  mediumIntent,
  sdkRequest,
} from "../support/anthropic-wire.js";

const compaction = {
  type: "compaction",
  content: "The minter read the cart and drafted the operation.",
  encrypted_content: "opaque-summary",
};

describe("long Claude conversations", () => {
  it("drops thinking bound to an edited history on every request, without compaction", async () => {
    const { model, bodies, betas } = claudeWire([
      claudeStream({ content: [{ type: "text", text: "Done" }] }),
    ]);
    await model.getResponse(sdkRequest("Mint it"));
    expect(betas).toStrictEqual(["thinking-binding-controls-2026-08-01"]);
    expect(bodies[0]?.["thinking"]).toStrictEqual({
      type: "adaptive",
      display: "summarized",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    });
    expect(bodies[0]).not.toHaveProperty("context_management");
    // The SDK sends betas as the header, not in the body.
    expect(bodies[0]).not.toHaveProperty("betas");
  });

  it("compacts on the server at the intent's threshold", async () => {
    const { model, bodies, betas } = claudeWire(
      [claudeStream({ content: [{ type: "text", text: "Done" }] })],
      () => ({ ...mediumIntent, compactAtTokens: 268_000 }),
    );
    await model.getResponse(sdkRequest("Mint it"));
    expect(betas).toStrictEqual(["compact-2026-01-12,thinking-binding-controls-2026-08-01"]);
    expect(bodies[0]?.["context_management"]).toStrictEqual({
      edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 268000 } }],
    });
  });

  it("keeps a compaction block as the SDK's compaction item and replays it unchanged", async () => {
    const { model, bodies } = claudeWire([
      claudeStream({ content: [compaction, { type: "text", text: "Continuing" }] }),
      claudeStream({ content: [{ type: "text", text: "Done" }] }),
    ]);
    const first = await model.getResponse(sdkRequest("Mint it"));
    expect(first.output[0]).toStrictEqual({
      type: "compaction",
      encrypted_content: JSON.stringify(compaction),
      providerData: { backend: "anthropic", model: claudeModel },
    });
    const history = JSON.parse(JSON.stringify(first.output)) as AgentInputItem[];
    await model.getResponse(
      sdkRequest([
        { role: "user", content: "Mint it" },
        ...history,
        { role: "user", content: "Go" },
      ]),
    );
    const messages = bodies[1]?.["messages"] as { content: unknown[] }[];
    expect(JSON.stringify(messages[1]?.content)).toBe(
      JSON.stringify([compaction, { type: "text", text: "Continuing" }]),
    );
  });

  it("starts a compacted conversation at its compaction, as the SDK sends it", async () => {
    const { model, bodies } = claudeWire([
      claudeStream({ content: [compaction, { type: "text", text: "Continuing" }] }),
      claudeStream({ content: [{ type: "text", text: "Done" }] }),
    ]);
    const first = await model.getResponse(sdkRequest("Mint it"));
    const history = JSON.parse(JSON.stringify(first.output)) as AgentInputItem[];
    await model.getResponse(sdkRequest([...history, { role: "user", content: "Go" }]));
    expect(JSON.stringify(bodies[1]?.["messages"])).toBe(
      JSON.stringify([
        { role: "assistant", content: [compaction, { type: "text", text: "Continuing" }] },
        { role: "user", content: [{ type: "text", text: "Go" }] },
      ]),
    );
  });

  it("reports the thinking blocks the API dropped", async () => {
    const dropped = {
      type: "thinking_dropped",
      path: "messages.1.content.0",
      reason: "prefix_binding_mismatch",
    };
    const { model } = claudeWire([
      claudeStream({ content: [{ type: "text", text: "Done" }], inputTransformations: [dropped] }),
    ]);
    const response = await model.getResponse(sdkRequest("Mint it"));
    expect(response.providerData).toStrictEqual({ inputTransformations: [dropped] });
  });
});
