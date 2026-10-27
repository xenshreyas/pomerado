import type { AgentInputItem, ModelRequest, SerializedTool } from "@openai/agents";
import { describe, expect, it } from "vitest";
import type { ModelIntent } from "../../src/models/backends/anthropic/intent.js";
import { anthropicRequest } from "../../src/models/backends/anthropic/request.js";

const model = "claude-opus-5-5";
const intent: ModelIntent = { effort: "medium", continuity: true, parallelToolCalls: true };
const readPage: SerializedTool = {
  type: "function",
  name: "read_page",
  description: "Read the page",
  parameters: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
    additionalProperties: false,
  },
  strict: true,
};

const request = (
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

const call = (callId: string): AgentInputItem => ({
  type: "function_call",
  callId,
  name: "read_page",
  arguments: JSON.stringify({ url: `https://shop.example.test/${callId}` }),
});
const result = (callId: string): AgentInputItem => ({
  type: "function_call_result",
  callId,
  name: "read_page",
  status: "completed",
  output: { type: "text", text: `page ${callId}` },
});

describe("anthropicRequest", () => {
  it("keeps the instructions in system behind a one-hour breakpoint", () => {
    const { params } = anthropicRequest(
      request("Mint the integration", { systemInstructions: "You mint integrations." }),
      model,
      { ...intent, effort: "low" },
    );
    expect(params).toStrictEqual({
      model,
      max_tokens: 64000,
      system: [
        {
          type: "text",
          text: "You mint integrations.",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "Mint the integration" }] }],
      thinking: {
        type: "adaptive",
        display: "summarized",
        block_binding: { prefix_mismatch_behavior: "drop_block" },
      },
      output_config: { effort: "low" },
      cache_control: { type: "ephemeral", ttl: "1h" },
      betas: ["thinking-binding-controls-2026-08-01"],
    });
  });

  it("puts leading system items in system and keeps a later one in the conversation", () => {
    const { params } = anthropicRequest(
      request([
        { role: "system", content: "Static guidance" },
        { role: "user", content: "Start" },
        { role: "system", content: "The page reloaded" },
      ]),
      model,
      intent,
    );
    expect(params.system).toStrictEqual([
      { type: "text", text: "Static guidance", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
    expect(params.messages.at(-1)).toStrictEqual({
      role: "system",
      content: [{ type: "text", text: "The page reloaded" }],
    });
  });

  it("sends a tool call and its result as tool_use and tool_result", () => {
    const { params } = anthropicRequest(
      request([{ role: "user", content: "Read it" }, call("toolu_1"), result("toolu_1")], {
        tools: [readPage],
      }),
      model,
      intent,
    );
    expect(params.tools).toStrictEqual([
      {
        name: "read_page",
        description: "Read the page",
        input_schema: readPage.type === "function" ? readPage.parameters : undefined,
        strict: true,
      },
    ]);
    expect(params.tool_choice).toStrictEqual({ type: "auto" });
    expect(params.messages.slice(1)).toStrictEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "read_page",
            input: { url: "https://shop.example.test/toolu_1" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "page toolu_1" }],
          },
        ],
      },
    ]);
  });

  it("returns every result of a turn in one user message, tool results first", () => {
    const { params } = anthropicRequest(
      request([
        { role: "user", content: "Read both" },
        {
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "On it" }],
        },
        call("toolu_1"),
        call("toolu_2"),
        result("toolu_1"),
        { role: "user", content: "Also check the cart" },
        result("toolu_2"),
      ]),
      model,
      intent,
    );
    expect(params.messages.map((message) => message.role)).toStrictEqual([
      "user",
      "assistant",
      "user",
    ]);
    const types = (index: number) => {
      const content = params.messages[index]?.content;
      return Array.isArray(content) ? content.map((block) => block.type) : content;
    };
    expect(types(1)).toStrictEqual(["text", "tool_use", "tool_use"]);
    expect(types(2)).toStrictEqual(["tool_result", "tool_result", "text"]);
  });

  it("drops items with no Claude form and names them", () => {
    const { params, dropped } = anthropicRequest(
      request([
        { role: "user", content: "Start" },
        { type: "reasoning", content: [], providerData: { encrypted_content: "openai" } },
        { type: "unknown", providerData: { type: "configuration_update" } },
        { type: "compaction", encrypted_content: "openai" },
        { role: "user", content: "Continue" },
      ]),
      model,
      intent,
    );
    expect(dropped).toStrictEqual(["reasoning", "unknown", "compaction"]);
    expect(params.messages).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Start" },
          { type: "text", text: "Continue" },
        ],
      },
    ]);
  });

  it("replays a stored Claude thinking block exactly", () => {
    const block = { type: "thinking", thinking: "Plan the read", signature: "sig_1" };
    const { params } = anthropicRequest(
      request([
        { role: "user", content: "Read it" },
        {
          type: "reasoning",
          content: [{ type: "input_text", text: "Plan the read" }],
          providerData: { backend: "anthropic", model, block },
        },
        call("toolu_1"),
        result("toolu_1"),
      ]),
      model,
      intent,
    );
    expect(params.messages[1]?.content).toStrictEqual([
      block,
      {
        type: "tool_use",
        id: "toolu_1",
        name: "read_page",
        input: { url: "https://shop.example.test/toolu_1" },
      },
    ]);
  });

  it("maps tool choice: none stays none, a forced choice goes as auto, one call when asked", () => {
    const choice = (toolChoice: string, parallelToolCalls = true) =>
      anthropicRequest(
        request("Go", { tools: [readPage], modelSettings: { toolChoice } }),
        model,
        { ...intent, parallelToolCalls },
      ).params.tool_choice;
    expect(choice("none")).toStrictEqual({ type: "none" });
    expect(choice("required")).toStrictEqual({ type: "auto" });
    expect(choice("read_page")).toStrictEqual({ type: "auto" });
    expect(choice("auto", false)).toStrictEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("refuses built-in tools Claude has no form for", () => {
    const tools: SerializedTool[] = [
      { type: "hosted_tool", name: "web_search" },
      { type: "computer", name: "computer" },
      { type: "shell", name: "shell" },
    ];
    for (const tool of tools)
      expect(() => anthropicRequest(request("Go", { tools: [tool] }), model, intent)).toThrow(
        `no form for the ${tool.type} tool`,
      );
  });
});
