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
