import type { SerializedTool } from "@openai/agents";
import { describe, expect, it } from "vitest";
import { anthropicRequest } from "../../src/models/backends/anthropic/request.js";
import { claudeSchema } from "../../src/models/backends/anthropic/schema.js";
import { claudeModel, mediumIntent, sdkRequest } from "../support/anthropic-wire.js";

const constrained = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 80, format: "email" },
    slug: { type: "string", pattern: "^[a-z]+$", format: "slug" },
    count: { type: "integer", minimum: 0, maximum: 9, multipleOf: 1 },
    tags: {
      type: "array",
      items: { type: "string", maxLength: 10 },
      minItems: 3,
      maxItems: 5,
      uniqueItems: true,
    },
    steps: { type: "array", items: { $ref: "#/$defs/step" }, minItems: 1 },
    minimum: { anyOf: [{ type: "number", exclusiveMinimum: 0 }, { type: "null" }] },
    kind: { oneOf: [{ const: "read" }, { enum: ["write", "delete"] }] },
  },
  required: ["name", "slug", "count", "tags", "steps", "minimum", "kind"],
  $defs: { step: { type: "object", properties: { label: { type: "string", maxLength: 9 } } } },
};

describe("claudeSchema", () => {
  it("drops the constraints Claude rejects and closes every object", () => {
    expect(claudeSchema(constrained)).toStrictEqual({
      type: "object",
      properties: {
        name: { type: "string", format: "email" },
        slug: { type: "string", pattern: "^[a-z]+$" },
        count: { type: "integer" },
        tags: { type: "array", items: { type: "string" } },
        steps: { type: "array", items: { $ref: "#/$defs/step" }, minItems: 1 },
        minimum: { anyOf: [{ type: "number" }, { type: "null" }] },
        kind: { anyOf: [{ const: "read" }, { enum: ["write", "delete"] }] },
      },
      required: ["name", "slug", "count", "tags", "steps", "minimum", "kind"],
      $defs: {
        step: {
          type: "object",
          properties: { label: { type: "string" } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    });
  });

  it("refuses an open record, which Claude cannot hold to a schema", () => {
    expect(() =>
      claudeSchema({
        type: "object",
        properties: { headers: { type: "object", additionalProperties: { type: "string" } } },
      }),
    ).toThrow("open record at $.headers");
  });
});

describe("anthropicRequest schemas", () => {
  const tool = (strict: boolean): SerializedTool => ({
    type: "function",
    name: strict ? "save" : "request_input",
    description: "A tool",
    parameters: {
      type: "object",
      properties: { note: { type: "string", maxLength: 40 } },
      required: ["note"],
      additionalProperties: !strict,
    },
    strict,
  });

  it("converts a strict tool's schema and sends a freeform tool's whole, without strict", () => {
    const { params } = anthropicRequest(
      sdkRequest("Go", { tools: [tool(true), tool(false)] }),
      claudeModel,
      mediumIntent,
    );
    expect(params.tools).toStrictEqual([
      {
        name: "save",
        description: "A tool",
        input_schema: {
          type: "object",
          properties: { note: { type: "string" } },
          required: ["note"],
          additionalProperties: false,
        },
        strict: true,
      },
      {
        name: "request_input",
        description: "A tool",
        input_schema: {
          type: "object",
          properties: { note: { type: "string", maxLength: 40 } },
          required: ["note"],
          additionalProperties: true,
        },
      },
    ]);
  });

  it("sends a structured output type as output_config.format beside the effort", () => {
    const { params } = anthropicRequest(
      sdkRequest("Review it", {
        outputType: {
          type: "json_schema",
          name: "decision",
          strict: true,
          schema: {
            type: "object",
            properties: { rationale: { type: "string", minLength: 1 } },
            required: ["rationale"],
            additionalProperties: false,
          },
        },
      }),
      claudeModel,
      mediumIntent,
    );
    expect(params.output_config).toStrictEqual({
      effort: "medium",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { rationale: { type: "string" } },
          required: ["rationale"],
          additionalProperties: false,
        },
      },
    });
  });
});
