import { Data, Effect, Schema } from "effect";
import type { ModelBackend } from "../models/backend.js";
import { anthropicBackend } from "../models/backends/anthropic/index.js";

/** The `parseArgs` option both CLIs read the backend from. */
export const modelBackendOption = { "model-backend": { type: "string" } } as const;

export const modelBackendUsage =
  "  --model-backend openai|anthropic  Model provider to mint with (default openai)";

/** A chosen backend that cannot mint on this machine, and what to do about it. */
export class ModelBackendUnavailable extends Data.TaggedError("ModelBackendUnavailable")<{
  readonly message: string;
}> {}

/** The backend `--model-backend` names, or else `POMERADO_MODEL_BACKEND`, OpenAI by default. */
export const modelBackendName = (
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
) =>
  Schema.decodeUnknown(Schema.Literal("openai", "anthropic"))(
    flag ?? env["POMERADO_MODEL_BACKEND"] ?? "openai",
  ).pipe(
    Effect.mapError(
      () =>
        new ModelBackendUnavailable({
          message: "Choose openai or anthropic for --model-backend. See --help.",
        }),
    ),
  );

/** How a Claude mint checks this machine at startup. Tests replace them. */
export interface AnthropicSetup {
  /** Loads `@anthropic-ai/sdk`, which only a host that chooses Claude installs. */
  readonly loadSdk: () => Promise<unknown>;
  /** Whether the SDK resolves a credential other than the environment's two variables. */
  readonly signedIn: () => Promise<boolean>;
}

const sdkSetup: AnthropicSetup = {
  loadSdk: () => import("@anthropic-ai/sdk"),
  // An `ant auth login` profile, or workload identity federation.
  signedIn: async () => {
    const { defaultCredentials } = await import(
      "@anthropic-ai/sdk/lib/credentials/credential-chain"
    );
    const baseURL = process.env["ANTHROPIC_BASE_URL"] ?? "https://api.anthropic.com";
    return (await defaultCredentials({ baseURL, fetch })) !== null;
  },
};

const missingPackage = (error: unknown) =>
  Reflect.get(Object(error), "code") === "ERR_MODULE_NOT_FOUND";
const installSdk =
  "--model-backend anthropic needs @anthropic-ai/sdk. " +
  "Install it with: npm install @anthropic-ai/sdk";
const setKey =
  "--model-backend anthropic needs ANTHROPIC_API_KEY. " +
  "Set it in the environment, or sign in with ant auth login.";

/**
 * The backend a mint runs on: none for OpenAI, the library's default, which checks no key, since
 * a host may route it through a proxy. Claude's needs its package and a credential its SDK
 * resolves: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or a signed-in profile.
 */
export const modelBackendFor = (
  name: "openai" | "anthropic",
  env: NodeJS.ProcessEnv = process.env,
  setup: AnthropicSetup = sdkSetup,
): Effect.Effect<ModelBackend | undefined, ModelBackendUnavailable> =>
  name === "openai"
    ? Effect.succeed(undefined)
    : Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: setup.loadSdk,
          catch: (error) =>
            new ModelBackendUnavailable({
              message: missingPackage(error) ? installSdk : "@anthropic-ai/sdk failed to load.",
            }),
        });
        const keyed = Boolean(env["ANTHROPIC_API_KEY"] || env["ANTHROPIC_AUTH_TOKEN"]);
        const signedIn =
          keyed || (yield* Effect.promise(() => setup.signedIn().catch(() => false)));
        if (!signedIn) return yield* new ModelBackendUnavailable({ message: setKey });
        return anthropicBackend();
      });

/** The backend a mint runs on, as `--model-backend` or else the environment names it, checked. */
export const chosenModelBackend = (flag: string | undefined) =>
  modelBackendName(flag).pipe(Effect.flatMap((name) => modelBackendFor(name)));
