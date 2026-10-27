import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { OpenAIProvider } from "@openai/agents";
import OpenAI from "openai";
import { expect } from "vitest";
import { lunaModel, solModel } from "../../src/models/models.js";

/*
 * Golden request fixtures: every Responses request a scenario sends, compared with the committed
 * file in `golden/` with `toStrictEqual`. Run the tests with `UPDATE_GOLDEN=1` to write the files
 * again, then review the diff.
 *
 * Each request keeps its method, path, headers and the SHA-256 of its body's exact bytes, which
 * proves the body unchanged, key order included. The body is kept to show its structure, so only
 * these change, in `normalized`:
 * - Headers that vary by machine, SDK version or attempt are dropped: user-agent and every
 *   x-stainless-* header (OS, architecture, runtime, package version, retry count, timeout).
 * - The tool and output schemas, `tools` and `text`, thousands of lines the same on every
 *   request, are kept as their SHA-256.
 * - An `input` that starts with every item of the request before it, as serialized, is kept as
 *   `{ carriedOver, added }`: that request's item count and the items after them.
 * - A string over 300 characters is kept as `<sha256:` its digest's first 12 hex digits, its
 *   length `chars>`, then its first 60 characters, so a changed prompt is still a changed line.
 * - The current model IDs are written `{{solModel}}` and `{{lunaModel}}`, since tests name them
 *   only through their constants.
 */

export type Body = Record<string, unknown>;

export interface Reply {
  readonly output?: readonly unknown[];
  readonly usage?: Record<string, unknown>;
  /** An error status the provider refuses the request with instead. */
  readonly status?: number;
}

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly sha256: string;
  readonly body: Body;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const shortened = (value: unknown): unknown => {
  if (typeof value === "string" && value.length > 300) {
    const digest = sha256(value).slice(0, 12);
    return `<sha256:${digest}…, ${value.length} chars> ${value.slice(0, 60)}…`;
  }
  if (Array.isArray(value)) return value.map(shortened);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shortened(item)]));
  return value;
};

/** The body as a fixture keeps it, after the request whose input items were `previous`. */
const normalized = (body: Body, previous: readonly string[]) => {
  const input = Array.isArray(body["input"]) ? (body["input"] as unknown[]) : [];
  const carried =
    previous.length > 0 && previous.every((item, index) => item === JSON.stringify(input[index]));
  return shortened(
    Object.fromEntries(
      Object.entries(body).map(([key, value]) => [
        key,
        key === "tools" || key === "text"
          ? sha256(JSON.stringify(value))
          : key === "input" && carried
            ? { carriedOver: previous.length, added: input.slice(previous.length) }
            : value,
      ]),
    ),
  ) as Body;
};
const models: Record<string, string> = { [solModel]: "{{solModel}}", [lunaModel]: "{{lunaModel}}" };
const placeholders = Object.fromEntries(Object.entries(models).map(([id, name]) => [name, id]));

/**
 * The real Responses client over a recording fetch, answering each request with `reply`. Each
 * response's ID is `resp_<n>`, its model the request's own. The client names no organization or
 * project, so OPENAI_ORG_ID and OPENAI_PROJECT_ID in the environment add no header.
 */
export const goldenProvider = (reply: (body: Body) => Reply) => {
  const requests: Recorded[] = [];
  let previous: string[] = [];
  const client = new OpenAI({
    apiKey: "synthetic-key",
    organization: null,
    project: null,
    maxRetries: 0,
    fetch: async (url, init) => {
      const raw = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(raw) as Body;
      const headers = [...new Headers(init?.headers).entries()]
        .filter(([name]) => name !== "user-agent" && !name.startsWith("x-stainless-"))
        .sort(([left], [right]) => (left < right ? -1 : 1));
      requests.push({
        method: init?.method ?? "GET",
        path: new URL(String(url)).pathname,
        headers: Object.fromEntries(headers),
        sha256: sha256(raw),
        body: normalized(body, previous),
      });
      previous = Array.isArray(body["input"])
        ? body["input"].map((item: unknown) => JSON.stringify(item))
        : [];
      const { output = [], usage, status } = reply(body);
      if (status !== undefined)
        return new Response(
          JSON.stringify({
            error: { message: "Synthetic refusal", type: "invalid_request_error" },
          }),
          { status, headers: { "content-type": "application/json" } },
        );
      return new Response(
        JSON.stringify({
          id: `resp_${requests.length}`,
          object: "response",
          created_at: 1,
          status: "completed",
          model: body["model"],
          output,
          usage: usage ?? { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  return { requests, provider: new OpenAIProvider({ openAIClient: client }) };
};

/** Compares the recorded requests with `golden/<name>.json`, or writes it with UPDATE_GOLDEN=1. */
export const expectGolden = (name: string, requests: readonly Recorded[]) => {
  const file = new URL(`golden/${name}.json`, import.meta.url);
  if (process.env["UPDATE_GOLDEN"] === "1") {
    if (process.env["CI"]) throw new Error("UPDATE_GOLDEN is for local runs only");
    const written = JSON.stringify(
      requests,
      (_key, value: unknown) => (typeof value === "string" ? (models[value] ?? value) : value),
      2,
    );
    // A fixture holds no path of this machine.
    for (const local of [tmpdir(), homedir()]) expect(written).not.toContain(local);
    writeFileSync(file, `${written}\n`);
    return;
  }
  const expected: unknown = JSON.parse(readFileSync(file, "utf8"), (_key, value: unknown) =>
    typeof value === "string" ? (placeholders[value] ?? value) : value,
  );
  expect(requests).toStrictEqual(expected);
};
