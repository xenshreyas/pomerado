import type Anthropic from "@anthropic-ai/sdk";
import type { AgentInputItem, ModelRequest, SerializedTool } from "@openai/agents";
import type { ModelIntent } from "../../backend.js";
import { applyPatchName, applyPatchTool } from "./apply-patch.js";
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
const compactionBeta = "compact-2026-01-12";
const bindingBeta = "thinking-binding-controls-2026-08-01";

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

const texts = (blocks: readonly Block[]) =>
  blocks.flatMap((block) => (block.type === "text" ? [block] : []));

/** An item this backend wrote; an OpenAI reasoning or compaction item has no Claude form. */
const ours = (providerData: Record<string, unknown> | undefined) =>
  providerData?.["backend"] === "anthropic";

/**
 * An item this backend wrote holds Claude's block exactly as it was returned. Claude binds each
 * thinking block to the bytes of the conversation before it, `tool_use` input and text included,
 * so a stored block replays as it is; an item from elsewhere is rebuilt from its fields.
 */
const storedBlock = (providerData: Record<string, unknown> | undefined): Block | undefined =>
  ours(providerData) ? (providerData?.["block"] as Block) : undefined;

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
    case "apply_patch_call":
      return {
        role: "assistant",
        blocks: [
          stored ?? {
            type: "tool_use",
            id: item.callId,
            name: applyPatchName,
            input: { operation: item.operation },
          },
        ],
      };
    case "apply_patch_call_output":
      return {
        role: "user",
        blocks: [
          {
            type: "tool_result",
            tool_use_id: item.callId,
            ...(item.output === undefined ? {} : { content: item.output }),
            ...(item.status === "failed" ? { is_error: true } : {}),
          },
        ],
      };
    case "reasoning":
      return stored === undefined ? undefined : { role: "assistant", blocks: [stored] };
    // The SDK's compaction item holds Claude's compaction block as JSON.
    case "compaction":
      return ours(item.providerData)
        ? { role: "assistant", blocks: [JSON.parse(item.encrypted_content) as Block] }
        : undefined;
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
    else if (turn.role === "system" && turns.length === 0) system.push(...texts(turn.blocks));
    else if (turns.at(-1)?.role === turn.role) turns.at(-1)?.blocks.push(...turn.blocks);
    else turns.push({ role: turn.role, blocks: [...turn.blocks] });
  }
  const messages = turns.map(({ role, blocks }): Anthropic.Beta.BetaMessageParam => {
    if (role === "system") return { role, content: texts(blocks) };
    const results = blocks.filter((block) => block.type === "tool_result");
    const rest = blocks.filter((block) => block.type !== "tool_result");
    return { role, content: [...results, ...rest] };
  });
  // The SDK sends a compacted conversation from its compaction on, which Claude reads as the
  // start of the conversation.
  const first = messages[0];
  const compacted =
    first?.role === "assistant" &&
    Array.isArray(first.content) &&
    first.content[0]?.type === "compaction";
  if (first?.role !== "user" && !compacted)
    throw new Error("A Claude conversation must start with a user message or a compaction");
  return { system, messages, dropped };
};

const tool = (tool: SerializedTool): Anthropic.Beta.BetaToolUnion => {
  if (tool.type === "apply_patch") return applyPatchTool;
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
 * The top-level `system`: the instructions, in their parts when the intent has them, then the
 * host's static context and any system items that lead the conversation. The cache breakpoint
 * ends the part every conversation of a release shares: the static context when there is one,
 * else the instructions' first part, else the whole of it.
 */
const systemBlocks = (
  request: ModelRequest,
  intent: ModelIntent,
  leading: readonly Anthropic.Beta.BetaTextBlockParam[],
) => {
  const instructions =
    intent.instructionParts ??
    (request.systemInstructions === undefined ? [] : [request.systemInstructions]);
  const staticContext = intent.staticContext ?? [];
  const system = [
    ...[...instructions, ...staticContext].map((text) => ({ type: "text" as const, text })),
    ...leading,
  ];
  const sharedEnd = () => {
    if (staticContext.length > 0) return instructions.length + staticContext.length - 1;
    if (intent.instructionParts !== undefined) return 0;
    return system.length - 1;
  };
  const breakpoint = sharedEnd();
  return system.map((block, index) =>
    index === breakpoint ? { ...block, cache_control: cacheControl } : block,
  );
};

/**
 * The Messages API request for one SDK request. The instructions stay in `system`, behind a
 * cache breakpoint, and the top-level automatic breakpoint caches the growing conversation after
 * it. OpenAI-only settings in `modelSettings`, such as `store` and sampling parameters Opus 5.5
 * rejects, are not sent.
 */
export const anthropicRequest = (
  request: ModelRequest,
  model: string,
  intent: ModelIntent,
): AnthropicRequest => {
  if (request.handoffs.length > 0) throw new Error("The Claude backend does not send handoffs");
  const { system: leading, messages, dropped } = conversation(request.input);
  const system = systemBlocks(request, intent, leading);
  const tools = request.tools.map(tool);
  return {
    params: {
      model,
      max_tokens: maxTokens,
      ...(system.length === 0 ? {} : { system }),
      messages,
      ...(tools.length === 0 ? {} : { tools, tool_choice: toolChoice(request, intent) }),
      // A history edit then costs the thinking blocks after it, not the build; the response's
      // `input_transformations` names each block the API dropped.
      thinking: {
        type: "adaptive",
        display: "summarized",
        block_binding: { prefix_mismatch_behavior: "drop_block" },
      },
      output_config: {
        effort: intent.effort,
        ...(request.outputType === "text"
          ? {}
          : { format: { type: "json_schema", schema: claudeSchema(request.outputType.schema) } }),
      },
      cache_control: cacheControl,
      ...(intent.compactAtTokens === undefined
        ? {}
        : {
            context_management: {
              edits: [
                {
                  type: "compact_20260112",
                  trigger: { type: "input_tokens", value: intent.compactAtTokens },
                },
              ],
            },
          }),
      betas: intent.compactAtTokens === undefined ? [bindingBeta] : [compactionBeta, bindingBeta],
    },
    dropped,
  };
};
