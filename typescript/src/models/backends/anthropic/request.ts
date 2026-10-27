import type Anthropic from "@anthropic-ai/sdk";
import type { AgentInputItem, ModelRequest, SerializedTool } from "@openai/agents";
import type { ModelIntent } from "./intent.js";
import { claudeSchema } from "./schema.js";

type Block = Anthropic.Beta.BetaContentBlockParam;
type Role = "user" | "assistant" | "system";
interface Turn {
  readonly role: Role;
  readonly blocks: Block[];
}

/** Thinking counts toward the limit, and every role gets the room a long agentic turn needs. */
const maxTokens = 64_000;
/** A build pauses for longer than five minutes between turns, such as while a page loads. */
const cacheControl = { type: "ephemeral", ttl: "1h" } as const;

export interface AnthropicRequest {
  readonly params: Anthropic.Beta.MessageCreateParamsNonStreaming;
  /** The types of input items that have no Claude form, such as OpenAI reasoning, in order. */
  readonly dropped: readonly string[];
}

const text = (part: { readonly type: string; readonly text?: string }) => {
  if (part.text === undefined || !["input_text", "output_text", "text"].includes(part.type))
    throw new Error(`The Claude backend does not send ${part.type} content`);
  return { type: "text" as const, text: part.text };
};

/**
 * An item this backend wrote holds Claude's block exactly as it was returned. Claude binds each
 * thinking block to the bytes of the conversation before it, `tool_use` input and text included,
 * so a stored block replays as it is; an item from elsewhere is rebuilt from its fields.
 */
const storedBlock = (providerData: Record<string, unknown> | undefined): Block | undefined =>
  providerData?.["backend"] === "anthropic" ? (providerData["block"] as Block) : undefined;

const turnOf = (item: AgentInputItem): Turn | undefined => {
  const stored = storedBlock(item.providerData);
  if (!("type" in item) || item.type === "message") {
    if (!("role" in item)) return undefined;
    if (item.role === "assistant" && stored !== undefined)
      return { role: "assistant", blocks: [stored] };
    const content =
      typeof item.content === "string" ? [{ type: "text", text: item.content }] : item.content;
    return { role: item.role, blocks: content.map(text) };
  }
  switch (item.type) {
    case "function_call":
      return {
        role: "assistant",
        blocks: [
          stored ?? {
            type: "tool_use",
            id: item.callId,
            name: item.name,
            input: JSON.parse(item.arguments),
          },
        ],
      };
    case "function_call_result":
      return {
        role: "user",
        blocks: [
          {
            type: "tool_result",
            tool_use_id: item.callId,
            content:
              typeof item.output === "string"
                ? item.output
                : (Array.isArray(item.output) ? item.output : [item.output]).map(text),
          },
        ],
      };
    case "reasoning":
      return stored === undefined ? undefined : { role: "assistant", blocks: [stored] };
    default:
      return undefined;
  }
};

/**
 * Claude's messages from the SDK's items. Consecutive turns of one role become one message, so all
 * results of a turn's tool calls go back together, with the `tool_result` blocks first as Claude
 * requires. System items before the first message join the top-level `system`; a later one stays
 * a mid-conversation system message, so the conversation before it is unchanged.
 */
const conversation = (input: ModelRequest["input"]) => {
  const items: AgentInputItem[] =
    typeof input === "string" ? [{ role: "user", content: input }] : input;
  const system: Anthropic.Beta.BetaTextBlockParam[] = [];
  const turns: Turn[] = [];
  const dropped: string[] = [];
  for (const item of items) {
    const turn = turnOf(item);
    if (turn === undefined) dropped.push(item.type ?? "message");
    else if (turn.role === "system" && turns.length === 0)
      system.push(...turn.blocks.flatMap((block) => (block.type === "text" ? [block] : [])));
    else if (turns.at(-1)?.role === turn.role) turns.at(-1)?.blocks.push(...turn.blocks);
    else turns.push({ role: turn.role, blocks: [...turn.blocks] });
  }
  const messages = turns.map(({ role, blocks }): Anthropic.Beta.BetaMessageParam => {
    if (role === "system")
      return { role, content: blocks.flatMap((block) => (block.type === "text" ? [block] : [])) };
    const results = blocks.filter((block) => block.type === "tool_result");
    const rest = blocks.filter((block) => block.type !== "tool_result");
    return { role, content: [...results, ...rest] };
  });
  if (messages[0]?.role !== "user")
    throw new Error("A Claude conversation must start with a user message");
  return { system, messages, dropped };
};

const tool = (tool: SerializedTool): Anthropic.Beta.BetaToolUnion => {
  if (tool.type !== "function")
    throw new Error(`The Claude backend has no form for the ${tool.type} tool ${tool.name}`);
  return {
    name: tool.name,
    description: tool.description,
    // A freeform tool, sent without `strict`, keeps its whole schema: Claude does not constrain
    // its input to it.
    input_schema: (tool.strict
      ? claudeSchema(tool.parameters)
      : tool.parameters) as Anthropic.Beta.BetaTool.InputSchema,
    ...(tool.strict ? { strict: true } : {}),
  };
};

/**
 * Claude Opus 5.5 rejects a forced call (`any` or a named tool) with a 400, so `required` and a
 * named tool go as `auto`: the prompt asks for the call, and a strict schema keeps its arguments
 * valid.
 */
const toolChoice = (request: ModelRequest, intent: ModelIntent): Anthropic.Beta.BetaToolChoice =>
  request.modelSettings.toolChoice === "none"
    ? { type: "none" }
    : { type: "auto", ...(intent.parallelToolCalls ? {} : { disable_parallel_tool_use: true }) };

/**
 * The Messages API request for one SDK request. The instructions stay in `system`, whose last
 * block is a cache breakpoint, and the top-level automatic breakpoint caches the growing
 * conversation after it. OpenAI-only settings in `modelSettings`, such as `store` and sampling
 * parameters Opus 5.5 rejects, are not sent.
 */
export const anthropicRequest = (
  request: ModelRequest,
  model: string,
  intent: ModelIntent,
): AnthropicRequest => {
  if (request.handoffs.length > 0) throw new Error("The Claude backend does not send handoffs");
  const { system, messages, dropped } = conversation(request.input);
  if (request.systemInstructions !== undefined)
    system.unshift({ type: "text", text: request.systemInstructions });
  const last = system.at(-1);
  if (last !== undefined) system[system.length - 1] = { ...last, cache_control: cacheControl };
  const tools = request.tools.map(tool);
  return {
    params: {
      model,
      max_tokens: maxTokens,
      ...(system.length === 0 ? {} : { system }),
      messages,
      ...(tools.length === 0 ? {} : { tools, tool_choice: toolChoice(request, intent) }),
      thinking: { type: "adaptive", display: "summarized" },
      output_config: {
        effort: intent.effort,
        ...(request.outputType === "text"
          ? {}
          : { format: { type: "json_schema", schema: claudeSchema(request.outputType.schema) } }),
      },
      cache_control: cacheControl,
    },
    dropped,
  };
};
