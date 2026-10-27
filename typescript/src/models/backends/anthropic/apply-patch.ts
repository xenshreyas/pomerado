import type Anthropic from "@anthropic-ai/sdk";
import { protocol } from "@openai/agents";

/**
 * The SDK's built-in `apply_patch` tool carries no description and no schema, since OpenAI's
 * models know it natively. Claude gets it as a function tool with the same operations and the
 * same headerless V4A diffs, so the workspace editor, edit ordering and recovery stay unchanged.
 */
export const applyPatchName = "apply_patch";

const path = { type: "string", description: "The file's path, relative to the workspace root." };
const operation = (
  type: string,
  properties: Record<string, object> = {},
  required: string[] = [],
) => ({
  type: "object",
  properties: { type: { const: type }, path, ...properties },
  required: ["type", "path", ...required],
  additionalProperties: false,
});

const description = [
  "Create, update or delete one file in the workspace. Send exactly one operation per call, " +
    "and call again for each further file.",
  "",
  "- create_file: `path` and `diff`, the new file's whole content with every line prefixed by `+`.",
  "- update_file: `path` and `diff`, a V4A diff of the existing file. " +
    "Set `moveTo` to rename the file too.",
  "- delete_file: `path` only.",
  "",
  "A V4A diff has no file header lines. It is one or more sections:",
  "- A section starts with `@@ ` followed by a line that occurs in the file before the change, " +
    "such as a function signature, which locates the change. Repeat `@@ ` lines to narrow the " +
    "location. A bare `@@` starts a section with no such line.",
  "- Every other line starts with one character: a space for an unchanged line, `-` for a line " +
    "to remove, `+` for a line to add.",
  "- Give about three unchanged lines before and after each change, copied exactly, so the " +
    "change can be found.",
  "- End a section that reaches the end of the file with the line `*** End of File`.",
  "",
  "Example update_file diff:",
  "@@ export const total = (items) => {",
  "   const subtotal = sum(items);",
  "-  return subtotal;",
  "+  return Math.round(subtotal * 100) / 100;",
  " };",
].join("\n");

export const applyPatchTool: Anthropic.Beta.BetaTool = {
  name: applyPatchName,
  description,
  input_schema: {
    type: "object",
    properties: {
      operation: {
        anyOf: [
          operation(
            "create_file",
            { diff: { type: "string", description: "Every line of the new file, prefixed by +." } },
            ["diff"],
          ),
          operation(
            "update_file",
            {
              diff: { type: "string", description: "A V4A diff of the file." },
              moveTo: { type: "string", description: "A new path for the file, to rename it." },
            },
            ["diff"],
          ),
          operation("delete_file"),
        ],
      },
    },
    required: ["operation"],
    additionalProperties: false,
  },
  strict: true,
};

/** The SDK's call for Claude's `apply_patch` tool use, its operation checked by the SDK. */
export const applyPatchCall = (
  block: Anthropic.Beta.BetaToolUseBlock,
): protocol.ApplyPatchCallItem => ({
  type: "apply_patch_call",
  callId: block.id,
  status: "completed",
  operation: protocol.ApplyPatchOperation.parse(Reflect.get(Object(block.input), "operation")),
});
