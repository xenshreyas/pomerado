import { Data } from "effect";
import type { ModelFailureKind } from "../../backend.js";

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

/**
 * The SDK's `APIError` fields this module reads. It reads them by shape, so loading it never
 * loads the SDK, which only a host that chooses Claude installs.
 */
interface ApiError {
  readonly status: number;
  /** The `error.type` of the response body, such as `billing_error`. */
  readonly type?: unknown;
  /** The whole response body. */
  readonly error?: unknown;
}

const apiError = (error: unknown): ApiError | undefined =>
  error instanceof Error && typeof Reflect.get(error, "status") === "number"
    ? (error as Error & ApiError)
    : undefined;

/** The API's own message: the SDK keeps the whole response body as the error's `error`. */
const apiMessage = (error: ApiError): string => {
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
export const classifyAnthropicFailure = (failure: unknown): ModelFailureKind | undefined => {
  if (failure instanceof ModelRefusal) return "refused";
  if (failure instanceof ModelInputTooLarge) return "input_too_large";
  const error = apiError(failure);
  if (error === undefined) return undefined;
  if (error.status === 402 || error.type === "billing_error") return "quota_exhausted";
  if (error.status === 401 || error.status === 403) return "authentication";
  if (error.status === 404) return "model_unavailable";
  if (error.status === 413) return "input_too_large";
  if (error.status !== 400) return undefined;
  const message = apiMessage(error);
  // A prompt over the model's context window is a 400 too, which names it only in the message.
  if (message.startsWith("prompt is too long")) return "input_too_large";
  if (configurationMessages.some((text) => message.includes(text))) return "backend_configuration";
  return undefined;
};
