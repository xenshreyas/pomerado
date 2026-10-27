import { APIError } from "@anthropic-ai/sdk";
import { Data } from "effect";

/** Claude declined the request, before or during its output; the partial output is discarded. */
export class ModelRefusal extends Data.TaggedError("ModelRefusal")<{
  readonly message: string;
  /** `stop_details.category`, such as `cyber`; null when Claude names none. */
  readonly category: string | null;
}> {}

/** Claude reached `max_tokens`, so its last block, possibly a tool call, is cut off. */
export class ModelOutputTruncated extends Data.TaggedError("ModelOutputTruncated")<{
  readonly message: string;
}> {}

/** The conversation no longer fits the model's context window. */
export class ModelInputTooLarge extends Data.TaggedError("ModelInputTooLarge")<{
  readonly message: string;
}> {}

export type AnthropicFailureKind =
  | "quota_exhausted"
  | "authentication"
  | "model_unavailable"
  | "input_too_large"
  | "refused"
  | "backend_configuration";

/** The API's own message: the SDK keeps the whole response body as the error's `error`. */
const apiMessage = (error: APIError): string => {
  const body = Object(Reflect.get(Object(error.error), "error"));
  const message: unknown = Reflect.get(body, "message");
  return typeof message === "string" ? message : "";
};

/**
 * A 400 that a retry cannot fix because the request's shape is not accepted where it was sent: a
 * gateway that strips or refuses a beta, or a thinking block bound to an edited conversation. The
 * API reports these only in the message, with the same `invalid_request_error` type as any other
 * bad request.
 */
const configurationMessages = [
  "for the `anthropic-beta` header",
  "block_binding: Extra inputs are not permitted",
  "The block is bound to a different conversation",
];

/** A Claude failure in neutral terms, or undefined for the generic HTTP-status and socket rules. */
export const classifyAnthropicFailure = (error: unknown): AnthropicFailureKind | undefined => {
  if (error instanceof ModelRefusal) return "refused";
  if (error instanceof ModelInputTooLarge) return "input_too_large";
  if (!(error instanceof APIError)) return undefined;
  if (error.status === 402 || error.type === "billing_error") return "quota_exhausted";
  if (error.status === 401 || error.status === 403) return "authentication";
  if (error.status === 404) return "model_unavailable";
  if (error.status === 413) return "input_too_large";
  const message = apiMessage(error);
  if (error.status === 400 && configurationMessages.some((text) => message.includes(text)))
    return "backend_configuration";
  return undefined;
};
