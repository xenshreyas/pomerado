import { describe, expect, it } from "vitest";
import {
  ModelInputTooLarge,
  ModelOutputTruncated,
  ModelRefusal,
  classifyAnthropicFailure,
} from "../../src/models/backends/anthropic/failure.js";
import { claudeError, claudeModel, claudeWire, sdkRequest } from "../support/anthropic-wire.js";

describe("classifyAnthropicFailure", () => {
  it.each([
    [402, "billing_error", "Your credit balance is too low", "quota_exhausted"],
    [401, "authentication_error", "invalid x-api-key", "authentication"],
    [403, "permission_error", "Not allowed for this credential", "authentication"],
    [404, "not_found_error", `model: ${claudeModel}`, "model_unavailable"],
    [413, "request_too_large", "Request exceeds the maximum size", "input_too_large"],
    [
      400,
      "invalid_request_error",
      "Unexpected value(s) `compact-2026-01-12` for the `anthropic-beta` header.",
      "backend_configuration",
    ],
    [
      400,
      "invalid_request_error",
      "thinking: block_binding: Extra inputs are not permitted",
      "backend_configuration",
    ],
    [
      400,
      "invalid_request_error",
      "messages.3.content.0: Invalid `signature` in `thinking` block. " +
        "The block is bound to a different conversation.",
      "backend_configuration",
    ],
    [400, "invalid_request_error", "messages: roles must alternate", undefined],
    [429, "rate_limit_error", "Slow down", undefined],
  ])("classifies a %i %s", async (status, type, message, kind) => {
    const { model } = claudeWire([claudeError(status, type, message)]);
    const error = await model
      .getResponse(sdkRequest("Mint it"))
      .catch((failure: unknown) => failure);
    expect(classifyAnthropicFailure(error)).toBe(kind);
  });

  it("classifies the backend's own stops", () => {
    expect(classifyAnthropicFailure(new ModelRefusal({ message: "No", category: "bio" }))).toBe(
      "refused",
    );
    expect(classifyAnthropicFailure(new ModelInputTooLarge({ message: "Full" }))).toBe(
      "input_too_large",
    );
    // A truncated turn is a plain model failure for the generic rules.
    expect(classifyAnthropicFailure(new ModelOutputTruncated({ message: "Cut" }))).toBe(undefined);
    expect(classifyAnthropicFailure(new Error("socket hang up"))).toBe(undefined);
  });
});
