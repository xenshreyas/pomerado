import Anthropic from "@anthropic-ai/sdk";
import type { ModelRequest } from "@openai/agents";
import type { ModelIntent } from "../../src/models/backend.js";
import { makeAnthropicModel } from "../../src/models/backends/anthropic/model.js";

export const claudeModel = "claude-opus-5-5";
export const mediumIntent: ModelIntent = {
  effort: "medium",
  continuity: true,
  parallelToolCalls: true,
};

export const sdkRequest = (
  input: ModelRequest["input"],
  extra: Partial<ModelRequest> = {},
): ModelRequest => ({
  input,
  modelSettings: {},
  tools: [],
  outputType: "text",
  handoffs: [],
  tracing: false,
  ...extra,
});

type Block = { readonly type: string } & Record<string, unknown>;

/** The stream events Claude sends for one content block, as deltas where the API sends them. */
const blockEvents = (block: Block, index: number): object[] => {
  const start = (content_block: object) => ({ type: "content_block_start", index, content_block });
  const delta = (value: object) => ({ type: "content_block_delta", index, delta: value });
  const stop = { type: "content_block_stop", index };
  switch (block.type) {
    case "text":
      return [
        start({ type: "text", text: "" }),
        delta({ type: "text_delta", text: block["text"] }),
        stop,
      ];
    case "thinking":
      return [
        start({ type: "thinking", thinking: "", signature: "" }),
        delta({ type: "thinking_delta", thinking: block["thinking"] }),
        delta({ type: "signature_delta", signature: block["signature"] }),
        stop,
      ];
    case "tool_use":
      return [
        start({ ...block, input: {} }),
        // A string input is the JSON text exactly as Claude sends it.
        delta({
          type: "input_json_delta",
          partial_json:
            typeof block["input"] === "string" ? block["input"] : JSON.stringify(block["input"]),
        }),
        stop,
      ];
    default:
      return [start(block), stop];
  }
};

export interface ScriptedMessage {
  readonly content: readonly Block[];
  readonly stopReason?: string;
  readonly stopDetails?: object;
  readonly usage?: object;
}

/** A Messages API stream that ends with `content` and the given stop. */
export const claudeStream = ({
  content,
  stopReason = "end_turn",
  stopDetails,
  usage = { input_tokens: 10, output_tokens: 5 },
}: ScriptedMessage) => {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: claudeModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    ...content.flatMap(blockEvents),
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null, stop_details: stopDetails ?? null },
      usage,
    },
    { type: "message_stop" },
  ];
  const body = events
    .map((event) => `event: ${Reflect.get(event, "type")}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return () =>
    new Response(body, {
      headers: { "content-type": "text/event-stream", "request-id": "req_1" },
    });
};

/** An API error response as Claude sends it. */
export const claudeError = (status: number, type: string, message: string) => () =>
  new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json", "request-id": "req_error" },
  });

/** A Claude model over a fetch that records each request and answers with the next reply. */
export const claudeWire = (
  replies: (() => Response)[],
  intentOf: (request: ModelRequest) => ModelIntent = () => mediumIntent,
) => {
  const bodies: Record<string, unknown>[] = [];
  const client = new Anthropic({
    apiKey: "synthetic-key",
    baseURL: "https://api.anthropic.test",
    maxRetries: 0,
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const reply = replies.shift();
      if (reply === undefined) throw new Error("No scripted reply left");
      return reply();
    },
  });
  return { model: makeAnthropicModel({ client, model: claudeModel, intentOf }), bodies };
};
