import { applyDiff, type AgentInputItem } from "@openai/agents";
import { describe, expect, it } from "vitest";
import { applyPatchTool } from "../../src/models/backends/anthropic/apply-patch.js";
import { anthropicRequest } from "../../src/models/backends/anthropic/request.js";
import { claudeSchema } from "../../src/models/backends/anthropic/schema.js";
import {
  claudeModel,
  claudeStream,
  claudeWire,
  mediumIntent,
  sdkRequest,
} from "../support/anthropic-wire.js";

// Claude's key order, which differs from the SDK schema's, must survive the round trip.
const update = {
  path: "operation/operation.mjs",
  type: "update_file",
  diff: "@@ export default 1\n-export default 1\n+export default 2",
  moveTo: "operation/next.mjs",
};
const patchUse = {
  type: "tool_use",
  id: "toolu_patch",
  name: "apply_patch",
  input: { operation: update },
};

describe("apply_patch on Claude", () => {
  it("offers the SDK's built-in apply_patch as a strict function tool", () => {
    const { params } = anthropicRequest(
      sdkRequest("Edit it", { tools: [{ type: "apply_patch", name: "apply_patch" }] }),
      claudeModel,
      mediumIntent,
    );
    expect(params.tools).toStrictEqual([applyPatchTool]);
    expect(applyPatchTool).toMatchObject({ name: "apply_patch", strict: true });
    // The schema is already inside what Claude's strict tools accept.
    expect(claudeSchema(applyPatchTool.input_schema)).toStrictEqual(applyPatchTool.input_schema);
  });

  it("describes a V4A diff the workspace editor applies", () => {
    const example = applyPatchTool.description?.split("Example update_file diff:\n")[1] ?? "";
    const source = [
      "export const total = (items) => {",
      "  const subtotal = sum(items);",
      "  return subtotal;",
      "};",
    ].join("\n");
    expect(applyDiff(source, example)).toBe(
      source.replace("return subtotal;", "return Math.round(subtotal * 100) / 100;"),
    );
  });

  it("reads an apply_patch tool use as the SDK's call, and replays it unchanged", async () => {
    const { model, bodies } = claudeWire([
      claudeStream({ content: [patchUse], stopReason: "tool_use" }),
      claudeStream({ content: [{ type: "text", text: "Done" }] }),
    ]);
    const first = await model.getResponse(sdkRequest("Edit it"));
    expect(first.output).toStrictEqual([
      {
        type: "apply_patch_call",
        callId: "toolu_patch",
        status: "completed",
        operation: update,
        providerData: { backend: "anthropic", model: claudeModel, block: patchUse },
      },
    ]);
    const failed: AgentInputItem = {
      type: "apply_patch_call_output",
      callId: "toolu_patch",
      status: "failed",
      output: "Invalid Context 0",
    };
    await model.getResponse(
      sdkRequest([{ role: "user", content: "Edit it" }, ...first.output, failed]),
    );
    const messages = bodies[1]?.["messages"] as { content: unknown[] }[];
    expect(JSON.stringify(messages[1]?.content)).toBe(JSON.stringify([patchUse]));
    expect(messages[2]?.content).toStrictEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_patch",
        content: "Invalid Context 0",
        is_error: true,
      },
    ]);
  });

  it("refuses an operation outside the SDK's schema", async () => {
    const { model } = claudeWire([
      claudeStream({
        content: [{ ...patchUse, input: { operation: { type: "rename_file", path: "a" } } }],
        stopReason: "tool_use",
      }),
    ]);
    await expect(model.getResponse(sdkRequest("Edit it"))).rejects.toThrow();
  });
});
