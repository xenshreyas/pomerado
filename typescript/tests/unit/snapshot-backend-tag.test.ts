import { Cause, Effect, Exit, Option, Schema } from "effect";
import { expect, it } from "vitest";
import { GuardianSessionSnapshot, makeGuardianSession } from "../../src/guardian/session.js";
import type { MintTurn } from "../../src/mint/contracts.js";
import { makeMinter } from "../../src/mint/openai.js";
import { MintAgentSnapshot } from "../../src/mint/recovery-contracts.js";
import { SnapshotBackendMismatch, backendTag } from "../../src/models/backend.js";
import { openAIBackend } from "../../src/models/backends/openai.js";
import { scriptedBackend } from "../support/scripted-backend.js";

const openAI = backendTag(openAIBackend(), "guardian");
const scripted = backendTag(scriptedBackend().backend, "guardian");
/** A conversation saved before snapshots named their backend. */
const untagged: GuardianSessionSnapshot = {
  version: 1,
  sdkVersion: "0.18.0",
  history: [{ role: "user", type: "message", content: "Synthetic earlier review" }],
  incomplete: false,
};
/** The schemas as a release from before backend tags reads them. */
const version1 = <F extends { readonly version: Schema.Schema.Any }>(fields: F) =>
  Schema.Struct({ ...fields, version: Schema.Literal(1) });

it("resumes a conversation saved before backend tags on OpenAI, tagged as version 1", () => {
  const session = makeGuardianSession({ initial: untagged, backend: openAI });
  expect(session.snapshot()).toStrictEqual({ ...untagged, backend: openAI });
});

it("refuses to resume a conversation on another backend than wrote it", () => {
  expect(() => makeGuardianSession({ initial: untagged, backend: scripted })).toThrow(
    new SnapshotBackendMismatch({ snapshot: "openai", backend: "scripted" }),
  );
  const theirs = makeGuardianSession({ backend: scripted }).snapshot();
  expect(() => makeGuardianSession({ initial: theirs, backend: openAI })).toThrow(
    new SnapshotBackendMismatch({ snapshot: "scripted", backend: "openai" }),
  );
});

it("writes another backend's conversation as version 2, which an older release refuses", () => {
  const snapshot = makeGuardianSession({ backend: scripted }).snapshot();
  expect(snapshot).toMatchObject({ version: 2, backend: scripted });
  expect(Schema.decodeUnknownEither(GuardianSessionSnapshot)(snapshot)._tag).toBe("Right");
  expect(Schema.decodeUnknownEither(version1(GuardianSessionSnapshot.fields))(snapshot)._tag).toBe(
    "Left",
  );
  const agent: MintAgentSnapshot = {
    version: 2,
    sdkVersion: "0.18.0",
    sdkState: "{}",
    modelCalls: 1,
    finalsWithoutTool: 0,
    tools: [],
    backend: scripted,
  };
  expect(Schema.decodeUnknownEither(MintAgentSnapshot)(agent)._tag).toBe("Right");
  expect(Schema.decodeUnknownEither(version1(MintAgentSnapshot.fields))(agent)._tag).toBe("Left");
});

it("refuses to resume a minter checkpoint on another backend than wrote it", async () => {
  const initial: MintAgentSnapshot = {
    version: 1,
    sdkVersion: "0.18.0",
    sdkState: "{}",
    modelCalls: 1,
    finalsWithoutTool: 0,
    tools: [],
  };
  // The minter refuses before it reads anything else of the turn.
  const turn = {
    recovery: { initial, save: () => Effect.void },
    runTool: (effect: Effect.Effect<unknown>) => Effect.runPromise(effect),
    reportDiagnostic: () => Effect.void,
  } as unknown as MintTurn;
  const exit = await Effect.runPromiseExit(makeMinter(scriptedBackend().backend).run(turn));
  const failure = Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.failureOption(exit.cause))
    : undefined;
  expect(failure?.failureDetail?.subCause).toBe("model_backend_mismatch");
});
