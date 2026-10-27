import type Anthropic from "@anthropic-ai/sdk";
import { Usage, type ModelResponse, type protocol } from "@openai/agents";
import { ModelInputTooLarge, ModelOutputTruncated, ModelRefusal } from "./failure.js";

/**
 * The neutral counts both backends report: input is all of it, cache reads and writes included,
 * and the details are flat numbers, as the SDK's saved run state requires. A server compaction is
 * its own sampling iteration, which the top-level counts leave out, so iterations are summed.
 */
export const anthropicUsage = (usage: Anthropic.Beta.BetaUsage): Usage => {
  const entries = usage.iterations?.length ? usage.iterations : [usage];
  const sum = (read: (entry: (typeof entries)[number]) => number | null) =>
    entries.reduce((total, entry) => total + (read(entry) ?? 0), 0);
  const cached = sum((entry) => entry.cache_read_input_tokens);
  const written = sum((entry) => entry.cache_creation_input_tokens);
  const inputTokens = sum((entry) => entry.input_tokens) + cached + written;
  const outputTokens = sum((entry) => entry.output_tokens);
  return new Usage({
    requests: 1,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    inputTokensDetails: [{ cached_tokens: cached, cache_write_tokens: written }],
  });
};

const outputItem = (
  block: Anthropic.Beta.BetaContentBlock,
  model: string,
): protocol.OutputModelItem => {
  switch (block.type) {
    case "text":
      return {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: block.text }],
      };
    case "tool_use":
      return {
        type: "function_call",
        callId: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
        status: "completed",
      };
    // Claude binds a thinking block to the conversation before it, so the block itself is kept and
    // replayed unchanged; the readable summary is for the transcript only.
    case "thinking":
    case "redacted_thinking":
      return {
        type: "reasoning",
        content: block.type === "thinking" ? [{ type: "input_text", text: block.thinking }] : [],
        providerData: { backend: "anthropic", model, block },
      };
    default:
      throw new Error(`Claude returned a ${block.type} block, which the backend does not read`);
  }
};

/**
 * The SDK's response for one finished Claude message. A stop that leaves the output unusable
 * throws instead, before any of it is read: a refusal, a cut-off at `max_tokens` (a truncated
 * tool call must never run), or a context window the conversation outgrew.
 */
export const anthropicResponse = (
  message: Anthropic.Beta.BetaMessage,
  requestId: string | undefined,
): ModelResponse & {
  readonly responseId: string;
  readonly output: protocol.OutputModelItem[];
} => {
  switch (message.stop_reason) {
    case "refusal":
      throw new ModelRefusal({
        message: message.stop_details?.explanation ?? "Claude declined the request",
        category: message.stop_details?.category ?? null,
      });
    case "max_tokens":
      throw new ModelOutputTruncated({ message: "Claude's output reached max_tokens" });
    case "model_context_window_exceeded":
      throw new ModelInputTooLarge({ message: "The conversation exceeds Claude's context window" });
    case "end_turn":
    case "tool_use":
    case "stop_sequence":
      break;
    default:
      // `pause_turn` comes only from server tools, which this backend never sends.
      throw new Error(`Claude stopped with ${message.stop_reason ?? "no reason"}`);
  }
  return {
    usage: anthropicUsage(message.usage),
    output: message.content.map((block) => outputItem(block, message.model)),
    responseId: message.id,
    ...(requestId === undefined ? {} : { requestId }),
  };
};
