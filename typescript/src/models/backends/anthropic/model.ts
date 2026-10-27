import type Anthropic from "@anthropic-ai/sdk";
import type { Model, ModelRequest, StreamEvent } from "@openai/agents";
import type { ModelIntent } from "./intent.js";
import { anthropicRequest } from "./request.js";
import { anthropicResponse } from "./response.js";

export interface AnthropicModelOptions {
  readonly client: Anthropic;
  readonly model: string;
  readonly intentOf: (request: ModelRequest) => ModelIntent;
}

/**
 * A `Model` over the Claude Messages API. Both calls stream, since a request with room for 64K
 * output tokens can outlast an unstreamed call, and read the finished message once it ends.
 */
export const makeAnthropicModel = ({ client, model, intentOf }: AnthropicModelOptions): Model => {
  const send = (request: ModelRequest) => {
    const { params, dropped } = anthropicRequest(request, model, intentOf(request));
    const stream = client.beta.messages.stream(params, { signal: request.signal });
    const response = async () => ({
      ...anthropicResponse(await stream.finalMessage(), stream.request_id ?? undefined),
      ...(dropped.length === 0 ? {} : { providerData: { droppedInputItems: dropped } }),
    });
    return { stream, response };
  };
  return {
    getResponse: (request) => send(request).response(),
    async *getStreamedResponse(request): AsyncIterable<StreamEvent> {
      const { stream, response } = send(request);
      yield { type: "response_started" };
      for await (const event of stream)
        if (event.type === "content_block_delta" && event.delta.type === "text_delta")
          yield { type: "output_text_delta", delta: event.delta.text };
      const { responseId, ...done } = await response();
      yield { type: "response_done", response: { ...done, id: responseId } };
    },
  };
};
