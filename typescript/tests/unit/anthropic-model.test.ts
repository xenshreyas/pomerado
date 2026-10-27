import type { AgentInputItem, StreamEvent } from "@openai/agents";
import { describe, expect, it } from "vitest";
import {
  ModelInputTooLarge,
  ModelOutputTruncated,
  ModelRefusal,
} from "../../src/models/backends/anthropic/failure.js";
import {
  claudeModel,
  claudeStream,
  claudeWire,
  sdkRequest,
} from "../support/anthropic-wire.js";

const thinking = { type: "thinking", thinking: "Read the cart first", signature: "sig_cart" };
const redacted = { type: "redacted_thinking", data: "opaque" };
const toolUse = { type: "tool_use", id: "toolu_1", name: "read_cart", input: { page: 2 } };

const collect = async (events: AsyncIterable<StreamEvent>) => {
  const seen: StreamEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
};

describe("makeAnthropicModel", () => {
  it("reads text, the message id, the request id and normalized usage", async () => {
    const { model } = claudeWire([
      claudeStream({
        content: [{ type: "text", text: "Done" }],
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
          output_tokens: 5,
        },
      }),
    ]);
    const response = await model.getResponse(sdkRequest("Mint it"));
    expect(response.output).toStrictEqual([
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Done" }],
      },
    ]);
    expect(response.responseId).toBe("msg_1");
    expect(response.requestId).toBe("req_1");
    expect(response.usage.inputTokens).toBe(130);
    expect(response.usage.outputTokens).toBe(5);
    expect(response.usage.totalTokens).toBe(135);
    expect(response.usage.inputTokensDetails).toStrictEqual([
      { cached_tokens: 100, cache_write_tokens: 20 },
    ]);
  });

  it("sums every sampling iteration, such as a compaction", async () => {
    const iteration = (type: string, input: number, output: number) => ({
      type,
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: 1,
      cache_creation_input_tokens: 2,
      cache_creation: null,
    });
    const { model } = claudeWire([
      claudeStream({
        content: [{ type: "text", text: "Done" }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          iterations: [iteration("compaction", 300, 40), iteration("message", 10, 5)],
        },
      }),
    ]);
    const { usage } = await model.getResponse(sdkRequest("Mint it"));
    expect([usage.inputTokens, usage.outputTokens]).toStrictEqual([316, 45]);
    expect(usage.inputTokensDetails).toStrictEqual([{ cached_tokens: 2, cache_write_tokens: 4 }]);
  });

  it("replays thinking blocks byte for byte, beside the tool call and its result", async () => {
    const { model, bodies } = claudeWire([
      claudeStream({ content: [thinking, redacted, toolUse], stopReason: "tool_use" }),
      claudeStream({ content: [{ type: "text", text: "Two items" }] }),
    ]);
    const first = await model.getResponse(sdkRequest("Read the cart"));
    expect(first.output.slice(0, 2)).toStrictEqual([
      {
        type: "reasoning",
        content: [{ type: "input_text", text: "Read the cart first" }],
        providerData: { backend: "anthropic", model: claudeModel, block: thinking },
      },
      {
        type: "reasoning",
        content: [],
        providerData: { backend: "anthropic", model: claudeModel, block: redacted },
      },
    ]);
    expect(first.output[2]).toStrictEqual({
      type: "function_call",
      callId: "toolu_1",
      name: "read_cart",
      arguments: '{"page":2}',
      status: "completed",
    });
    const result: AgentInputItem = {
      type: "function_call_result",
      callId: "toolu_1",
      name: "read_cart",
      status: "completed",
      output: "2 items",
    };
    // A saved run state goes through JSON, so the replay must survive it.
    const history = JSON.parse(JSON.stringify(first.output)) as AgentInputItem[];
    await model.getResponse(
      sdkRequest([{ role: "user", content: "Read the cart" }, ...history, result]),
    );
    const messages = bodies[1]?.["messages"] as { content: unknown[] }[];
    const replayed = JSON.stringify(messages[1]?.content);
    expect(replayed).toBe(JSON.stringify([thinking, redacted, toolUse]));
    expect(messages[2]?.content).toStrictEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: "2 items" },
    ]);
  });

  it("streams text deltas, then one response_done with the output and usage", async () => {
    const { model } = claudeWire([claudeStream({ content: [{ type: "text", text: "Done" }] })]);
    const events = await collect(model.getStreamedResponse(sdkRequest("Mint it")));
    expect(events.map((event) => event.type)).toStrictEqual([
      "response_started",
      "output_text_delta",
      "response_done",
    ]);
    expect(events[1]).toStrictEqual({ type: "output_text_delta", delta: "Done" });
    const done = events[2];
    expect(done?.type === "response_done" && done.response).toMatchObject({
      id: "msg_1",
      requestId: "req_1",
      usage: { inputTokens: 10, outputTokens: 5 },
      output: [{ type: "message", content: [{ type: "output_text", text: "Done" }] }],
    });
  });

  it("names the input items it dropped", async () => {
    const { model } = claudeWire([claudeStream({ content: [{ type: "text", text: "Done" }] })]);
    const response = await model.getResponse(
      sdkRequest([
        { role: "user", content: "Mint it" },
        { type: "reasoning", content: [], providerData: { encrypted_content: "openai" } },
      ]),
    );
    expect(response.providerData).toStrictEqual({ droppedInputItems: ["reasoning"] });
  });

  it("discards a mid-stream refusal's partial output and reports its category", async () => {
    const { model } = claudeWire([
      claudeStream({
        content: [{ type: "text", text: "Here is how" }],
        stopReason: "refusal",
        stopDetails: { type: "refusal", category: "cyber", explanation: "Declined" },
      }),
    ]);
    const events: StreamEvent[] = [];
    const error = await (async () => {
      for await (const event of model.getStreamedResponse(sdkRequest("Mint it")))
        events.push(event);
    })().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ModelRefusal);
    expect(error).toMatchObject({ category: "cyber", message: "Declined" });
    expect(events.some((event) => event.type === "response_done")).toBe(false);
  });

  it("never returns a tool call cut off at max_tokens", async () => {
    const { model } = claudeWire([claudeStream({ content: [toolUse], stopReason: "max_tokens" })]);
    await expect(model.getResponse(sdkRequest("Mint it"))).rejects.toBeInstanceOf(
      ModelOutputTruncated,
    );
  });

  it("reports a conversation over the context window as input too large", async () => {
    const { model } = claudeWire([
      claudeStream({ content: [], stopReason: "model_context_window_exceeded" }),
    ]);
    await expect(model.getResponse(sdkRequest("Mint it"))).rejects.toBeInstanceOf(
      ModelInputTooLarge,
    );
  });
});
