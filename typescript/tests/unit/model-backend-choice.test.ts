import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { modelBackendFor, modelBackendName } from "../../src/standalone/model-backend-choice.js";
import type { AnthropicSetup } from "../../src/standalone/model-backend-choice.js";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.either(effect));
const message = (result: Either.Either<unknown, { readonly message: string }>) =>
  Either.isLeft(result) ? result.left.message : undefined;

/** A machine with the SDK installed and no profile signed in, which records what it checked. */
const machine = (overrides: Partial<AnthropicSetup> = {}) => {
  const checked: string[] = [];
  const setup: AnthropicSetup = {
    loadSdk: async () => checked.push("sdk"),
    signedIn: async () => {
      checked.push("profile");
      return false;
    },
    ...overrides,
  };
  return { setup, checked };
};

describe("modelBackendName", () => {
  it("reads the flag, then POMERADO_MODEL_BACKEND, and defaults to openai", async () => {
    expect(await run(modelBackendName(undefined, {}))).toStrictEqual(Either.right("openai"));
    const env = { POMERADO_MODEL_BACKEND: "anthropic" };
    expect(await run(modelBackendName(undefined, env))).toStrictEqual(Either.right("anthropic"));
    expect(await run(modelBackendName("openai", env))).toStrictEqual(Either.right("openai"));
  });

  it("refuses a backend it does not offer", async () => {
    expect(message(await run(modelBackendName("gemini", {})))).toContain(
      "Choose openai or anthropic for --model-backend",
    );
    expect(
      message(await run(modelBackendName(undefined, { POMERADO_MODEL_BACKEND: "claude" }))),
    ).toContain("Choose openai or anthropic");
  });
});

describe("modelBackendFor", () => {
  it("checks nothing for openai, which keeps the library's default", async () => {
    const { setup, checked } = machine();
    expect(await run(modelBackendFor("openai", {}, setup))).toStrictEqual(Either.right(undefined));
    expect(checked).toStrictEqual([]);
  });

  it("runs Claude with a key in the environment or a signed-in profile", async () => {
    const env = { ANTHROPIC_API_KEY: "synthetic-key" };
    const keyed = await run(modelBackendFor("anthropic", env, machine().setup));
    expect(Either.getOrThrow(keyed)?.id).toBe("anthropic");
    const profile = machine({ signedIn: async () => true });
    const signedIn = await run(modelBackendFor("anthropic", {}, profile.setup));
    expect(Either.getOrThrow(signedIn)?.id).toBe("anthropic");
  });

  it("names ANTHROPIC_API_KEY when no credential resolves", async () => {
    const { setup, checked } = machine();
    expect(message(await run(modelBackendFor("anthropic", {}, setup)))).toBe(
      "--model-backend anthropic needs ANTHROPIC_API_KEY. " +
        "Set it in the environment, or sign in with ant auth login.",
    );
    expect(checked).toStrictEqual(["sdk", "profile"]);
  });

  it("gives the install command when @anthropic-ai/sdk is missing", async () => {
    const missing = Object.assign(new Error("Cannot find package '@anthropic-ai/sdk'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    const { setup } = machine({ loadSdk: () => Promise.reject(missing) });
    const env = { ANTHROPIC_API_KEY: "synthetic-key" };
    expect(message(await run(modelBackendFor("anthropic", env, setup)))).toBe(
      "--model-backend anthropic needs @anthropic-ai/sdk. " +
        "Install it with: npm install @anthropic-ai/sdk",
    );
  });
});
