# Pluggable model backends: run Pomerado on OpenAI or Claude

Status: draft v2 for discussion, revised after an independent design review. Branch
`feat/pluggable-model-providers`.

## Problem statement

Pomerado can build integrations only with OpenAI models. The README, the CLI help and the setup guide all
require `OPENAI_API_KEY`. A developer who has an Anthropic key and no OpenAI account can't mint.

The library accepts a `ModelProvider` per agent (`minterProvider`, `guardianProvider`,
`outcomeReviewerProvider`), but that seam is shallow, because the agents build OpenAI Responses API wire
shapes before any provider sees the request. They do this in two places.

**In agent settings:**
- `store: false` and `include: ["reasoning.encrypted_content"]` (`withReasoningContinuity`)
- `prompt_cache_key` and `prompt_cache_options` (`withPromptCache`)
- `context_management` from `compaction().samplingParams()`
- `reasoning.context: "all_turns"`

**In request wrappers stacked over the provider:**
- **Mint `layout`:** `withCachedPrefix`, which moves instructions into developer-role `unknown` items with
  12-hour content-part breakpoints; `withAllowedTools`; and `withCacheComparison`.
- **Guardian:** `instructionsAsMessages` and `collectingCacheDiagnostics`.
- **Prewarm:** `prewarmInstructions`.
- **History items:** `compaction_trigger` items, written by idle compaction and Guardian's `compactBefore`,
  and `configuration_update` items, written for Guardian's per-review effort.

The sandbox's filesystem capability also hands the minter OpenAI's built-in `apply_patch` tool type. It
picks that type whenever the model object's constructor name lacks `ChatCompletions`, and Pomerado's
wrappers are always plain objects.

So a non-OpenAI provider would have to reverse-engineer OpenAI's wire format before answering a single call.

## Solution

Pomerado gains one seam, the **model backend**. A backend owns everything that differs between providers.
It wraps a base provider with the request shaping, response reading and failure classification for one
provider's API. The agents describe each request's needs in neutral terms, the **model intent**, and hand
the intent to the backend in process. Nothing new travels in `providerData` or in history.

Two backends ship:
- **`openai`**, the default. Its wrapping is today's stacked wrappers and settings helpers, moved without
  edits. It wraps whatever provider is in use: a host's `*Provider` option, or the SDK default resolved at
  call time. Full-body golden fixtures, added before the refactor, prove its requests don't change.
- **`anthropic`**. A native `Model` over the official `@anthropic-ai/sdk` that calls the Claude Messages
  API.

A user picks a backend with `--model-backend anthropic` (or `POMERADO_MODEL_BACKEND=anthropic`) and sets
`ANTHROPIC_API_KEY`. Integrations need no model at run time, so a Claude-minted integration runs like any
other.

## Glossary

| Term | Meaning |
|---|---|
| **Model backend** | Pomerado's module for one model provider. Holds the base provider, the model per role, the feature set and failure classification. Wraps, and is not the same as, the SDK's `ModelProvider`. |
| **Role** | Which agent a call is for: `minter`, `guardian` or `outcome_reviewer`. |
| **Model intent** | The neutral description of one request's needs: effort, reasoning continuity, cached prefix, offered tools, compaction threshold, prewarm. An in-process value. It's never serialized and never sent. |
| **Feature set** | The intent features a backend honors, such as background compaction or prewarm. Callers check a feature before relying on it and skip the work when it's absent. |
| **Backend tag** | The backend id and model recorded in a saved snapshot. Only the backend that wrote a snapshot reads it back. |

## User stories

1. As a developer with only an Anthropic key, I want to mint an integration with Claude, so that I don't need an OpenAI account.
2. As a developer, I want to choose the backend with one CLI flag or environment variable, so that switching is trivial.
3. As an existing OpenAI user, I want nothing to change unless I opt in, so that my requests, costs and cache hit rates stay identical.
4. As an MCP client user, I want `pomerado-mcp mint --model-backend anthropic` to work, so that my agent can mint with Claude.
5. As a developer choosing Claude, I want a clear startup error when `ANTHROPIC_API_KEY` or `@anthropic-ai/sdk` is missing, so that I know exactly what to fix.
6. As a developer, I want my Anthropic key read only from the environment, never from flags, files or chat, so that it follows the same rules as the OpenAI key.
7. As a developer, I want integrations minted with Claude to run with `pomerado run` exactly like OpenAI ones, so that the integration format doesn't depend on the backend.
8. As a library host, I want to pass `modelBackend` to `createPomerado`, so that I can choose or supply a backend in code.
9. As a library host with a custom OpenAI client, a proxy or `setDefaultModelProvider`, I want the OpenAI backend to wrap my provider exactly as today, so that nothing I configured is bypassed.
10. As a library host, I want the per-agent `*Provider` options to keep working, so that my code and tests don't break.
11. As the hosted Pomerado product, I want every `./core/*` export to keep its name and behavior, with new names only added beside old ones, so that host protocol 1 stays valid.
12. As the hosted product, I want saved minter and Guardian snapshots to record the backend that wrote them, so that a resume never feeds Claude's thinking to OpenAI or the reverse.
13. As the hosted product, I want an older host to refuse a Claude snapshot by name, not silently resume it as OpenAI, so that rollbacks and mixed fleets stay safe.
14. As an operator, I want usage reported with the same neutral counts on both providers (all input including cache reads and writes, cache reads, cache writes, output), so that dashboards and the compaction watermark work.
15. As an operator, I want Claude's spent credit reported as `model_quota_exhausted`, and its authentication failure as an authentication failure, so that MCP errors stay actionable.
16. As an operator, I want a Claude refusal reported as a named, non-retried outcome, so that a declined request isn't treated as an outage.
17. As an operator behind an Anthropic gateway that strips beta headers, I want a named configuration failure or a recorded degrade, so that a missing beta doesn't silently corrupt a build.
18. As a developer minting sign-in or payment flows, I want classifier refusals reported plainly with what was declined, so that I can tell a refusal from a bug.
19. As the minter, I want `apply_patch` to work on Claude with the same V4A operations, so that the workspace editor, edit ordering and recovery stay unchanged.
20. As the minter, I want my reasoning carried across turns on Claude (thinking blocks replayed unchanged), so that long builds keep their reasoning.
21. As the minter, I want compaction at my threshold on Claude, so that long builds stay within cost and context bounds.
22. As Guardian, I want my structured decision enforced by schema on Claude, so that reviews parse.
23. As Guardian, I want my reasoning effort to keep coming from my own settings and the host's per-review choice, so that switching providers never quietly lowers review effort.
24. As a contributor, I want one contract suite that runs every backend over scripted responses with no real model calls, so that a new backend is easy to verify.
25. As a contributor, I want an offline test proving the Claude conversation is append-only, so that a future edit that breaks thinking replay fails CI.
26. As a contributor, I want model IDs still named only in `models.ts`, with the test enforcing it for `claude-` IDs too, so that a model change stays a one-line edit.
27. As a maintainer, I want the work in small PRs, each passing the full check list, so that every PR is reviewable on its own.
28. As a maintainer, I want `@anthropic-ai/sdk` as an optional peer dependency loaded only when chosen, so that OpenAI users install nothing new.
29. As a developer, I want the docs to list each backend's features and where Claude behaves differently, so that I know what to expect.

## Implementation decisions

### 1. The model backend interface

```ts
// Sketch: names are proposals.
export type ModelRole = "minter" | "guardian" | "outcome_reviewer";

export interface ModelBackend {
  /** Stable id for snapshots, traces and runtime records. */
  readonly id: "openai" | "anthropic" | (string & {});
  /** The model a role runs on (IDs come from models.ts). */
  readonly model: (role: ModelRole) => string;
  /**
   * The provider a role's Runner uses: the backend's shaping over `base`, with the request's intent
   * from `intentOf`. The OpenAI backend's base defaults to the SDK default provider, resolved at call
   * time; the Anthropic backend's base defaults to its own provider. A host's `*Provider` option is
   * the base when set.
   */
  readonly provider: (
    role: ModelRole,
    intentOf: (request: ModelRequest) => ModelIntent,
    base?: ModelProvider,
  ) => ModelProvider;
  readonly features: BackendFeatures;
  /** Neutral failure kind, tried before the generic HTTP-status and socket rules. */
  readonly classify: (error: unknown) => ModelFailureKind | undefined;
}

export interface ModelIntent {
  readonly effort: "low" | "medium";
  readonly continuity: boolean;
  readonly parallelToolCalls: boolean;
  readonly cache?: { readonly key?: string; readonly compareWith?: string };
  readonly offeredTools?: readonly string[];
  readonly compactAtTokens?: number;
  readonly prewarm?: boolean;
}

export interface BackendFeatures {
  readonly backgroundCompaction: boolean; // idle compaction, Guardian compactBefore
  readonly prewarm: boolean;
  readonly cacheDiagnostics: boolean;
  readonly effortChangeKeepsCache: boolean; // Guardian per-review effort without a cache reset
}
```

- **Why this seam.** Pomerado already stacks its OpenAI shaping as wrappers over
  `runner.config.modelProvider`:
  - the mint `cacheLayout` and the retry wrapper (`mint/openai.ts`)
  - `instructionsAsMessages` and `collectingCacheDiagnostics` (Guardian)
  - the outcome reviewer's equivalents

  The backend takes over exactly those places. The OpenAI backend's `provider(...)` is that same stack,
  moved; the Anthropic backend's is a translator into the Messages API.
- **Two real adapters.** OpenAI and Anthropic each implement the seam, and the scripted test backend
  exercises it.
- **Exported helpers keep their behavior.** `withPromptCache`, `withReasoningContinuity`, `withCachedPrefix`,
  `prewarmInstructions` and the others stay exported and unchanged. Only their call sites move into the
  OpenAI backend.
- **History items stay backend-owned.** `compaction_trigger` and `configuration_update` stay exactly as
  they are, written by the OpenAI backend only. The backend tag guarantees only their writer reads them.
  Shared code asks the backend's feature set whether background compaction or an effort change applies,
  and does nothing when it doesn't.

### 2. The Anthropic backend: request translation

| Pomerado / SDK | Claude Messages API |
|---|---|
| instructions | `system` text blocks, never moved into messages. `cache_control: {type: "ephemeral", ttl: "1h"}` on the last static block, plus top-level automatic `cache_control` for the tail. |
| `cache.key` | ignored. Claude caches are scoped by workspace and model. |
| `effort` | `output_config.effort`, always sent explicitly. It comes from each role's existing settings: minter default `medium`; Guardian default `medium` plus the host's per-review choice. |
| `continuity`, reasoning items | `thinking: {type: "adaptive", display: "summarized"}`. Each `thinking` / `redacted_thinking` block becomes one reasoning item. Its `providerData` holds the block exactly as received, tagged with backend id and model. Every block is replayed unchanged on every request; the API itself drops blocks the current model can't read. |
| `max_tokens` (required on Claude; OpenAI requests leave it unset) | 64000 for every role, always streamed. Thinking counts toward it. |
| function tools | `{name, description, input_schema, strict: true}`. Claude rejects constraints Pomerado's schemas use (`minLength`, `maxLength`, numeric bounds), so schemas are converted down to the supported subset, and every input is validated client-side with the tool's existing Effect schema. Freeform tools (`request_input`, `mint_update`) are sent without `strict`. |
| `apply_patch` built-in (`SerializedApplyPatchTool` carries no description and no schema) | a function tool `apply_patch`, whose description, V4A grammar and JSON schema the backend writes. One operation per call: `create_file{path, diff}`, `update_file{path, diff, moveTo?}`, `delete_file{path}`. `tool_use` maps back to `apply_patch_call {callId, status, operation}`, and `apply_patch_call_output` maps to `tool_result` (`is_error` when `status: "failed"`). The editor, edit ordering, observer `takeNativeCall` and recovery stay as they are. |
| `view_image` output | not offered to Claude, the same as on OpenAI today (Pomerado filters it out). |
| `offeredTools` | not sent. All tools go in a fixed order, and the host's `refuseNotOffered` keeps refusing calls the turn doesn't offer. Its ordinary result goes back as a plain `tool_result`. |
| `parallelToolCalls: false` | `tool_choice: {type: "auto", disable_parallel_tool_use: true}`. All results of one turn go back in one user message, `tool_result` blocks first. Consecutive same-role items are merged. |
| `toolChoice: "none"` (Guardian's last turn) | `tool_choice: {type: "none"}` |
| `outputType` json_schema | `output_config.format`, converted down to the same subset as tools and validated client-side |
| `compactAtTokens` | server compaction: beta `compact-2026-01-12`, `context_management.edits: [{type: "compact_20260112", ...}]`. The `compaction` block is stored as the SDK `compaction` item, as JSON in `encrypted_content`. v1 keeps today's thresholds (268K minter, 240K reviewer). They bound cost and context quality, not the window: Opus 5.5 has 1M. |
| idle compaction, Guardian `compactBefore` | `features.backgroundCompaction: false` in v1, so callers skip them and rely on threshold compaction. On-demand compaction (beta `compact-2026-09-04`) is a follow-up. |
| prewarm | `features.prewarm: false` in v1. The first real request writes the 1-hour cache. Guardian's prewarm would also conflict with Claude: it sends `output_config.format`, which a `max_tokens: 0` request rejects. |
| cache comparison | `features.cacheDiagnostics: false` in v1 |
| Guardian per-review effort change | a request-level `output_config.effort` change. The messages cache resets, and `features.effortChangeKeepsCache` is false. The per-message effort beta is a follow-up. |
| transport | `messages.stream(...)` then `finalMessage()` for both `getResponse` and `getStreamedResponse`. `eager_input_streaming` stays off, because Pomerado consumes whole messages. |
| SDK retries | the Anthropic SDK's defaults stay on (2 retries), matching the OpenAI client. Pomerado's own retry runs on top, as today. |

**Betas.** v1 sends only two:
- `compact-2026-01-12` (threshold compaction)
- `thinking-binding-controls-2026-08-01` (see preserved thinking below)

A 400 that names an unknown beta is classified as `backend_configuration`, with the beta's name in the
message. The build stops with that reason; it isn't retried as an outage.

**Response reading:**

| Response | Pomerado |
|---|---|
| `responseId`, `requestId` | from the message id and the request-id header |
| `stop_reason: "refusal"` | throws a typed `ModelRefusal` (kind `refused`, with `stop_details.category`). Partial output from a mid-stream refusal is discarded. |
| `stop_reason: "max_tokens"` | a truncated `tool_use` is never run. The turn ends as a model failure named `output_truncated`. |
| `stop_reason: "model_context_window_exceeded"` | `input_too_large` |
| `stop_reason: "pause_turn"` | can't occur, because v1 sends no server tools. Treated as a model failure if it does. |
| usage | input = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`; cached = `cache_read_input_tokens`; output = `output_tokens`. Entries in `usage.iterations` (compaction) are summed. Details stay flat numbers, as RunState requires. Cache writes go in `cache_write_tokens`; reasoning tokens aren't reported. |

### 3. Preserved thinking: keeping Claude's conversation append-only

Claude binds each thinking block to the exact earlier conversation: system, tools and every earlier message.
For accounts created on or after 2026-08-31, editing that history is a 400.

The Anthropic backend:
1. Stores and replays content blocks exactly as received. It never rebuilds them from neutral items.
2. Sends `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` on every request, under the beta
   above, so a harness edit costs reasoning instead of the build.
3. Counts the response's `input_transformations` drops in the runtime record and trace. A
   `prefix_binding_mismatch` means a Pomerado edit to fix.

Every place Pomerado rewrites history today has a stated Claude form:

| Site | What it does today | On the Anthropic backend |
|---|---|---|
| instructions moved into developer items (`withCachedPrefix`, `instructionsAsMessages`) | OpenAI cache layout | not applied. Instructions stay in `system`. |
| `afterProviderCompaction` skills note (mint) | inserts a note right after the compaction item | the note is appended at the end of the next user turn, after its `tool_result` blocks |
| idle compaction window swap | background compaction | off (`backgroundCompaction: false`) |
| Guardian `compactBefore` window | background compaction | off |
| Guardian `view` re-inserting the effort item after compaction | OpenAI effort item | not applied. Effort is request-level. |
| Guardian `backstopped` / `withoutAutomaticCompaction` stripping effort items | OpenAI-only repair | moved into the OpenAI backend |
| synthetic results for interrupted calls (Guardian) | appends results for dangling calls | kept. It only appends, and Claude needs a result for every `tool_use`. |
| outcome reviewer stripping minter reasoning | builds a new conversation from minter history | kept. It's a different conversation, so binding doesn't apply. |

An offline test enforces the rule. In a scripted Anthropic run of a full mint and a Guardian session, each
request's `system`, `tools` and `messages` (with `cache_control` removed) must be a byte prefix of the next
request's, except across a server compaction.

### 4. Models per role (in `models.ts`)

| Role | `openai` | `anthropic` |
|---|---|---|
| minter | `gpt-6.1-sol` (unchanged) | `claude-opus-5-5` |
| guardian, outcome_reviewer | `gpt-6-luna` (unchanged) | `claude-opus-5-5` (see open question 1) |

- Effort comes from each role's existing settings, never from the backend table.
- `model-ids.test.ts` widens to `claude-` IDs.

### 5. Failures in neutral terms

`backend.classify` runs before the existing generic rules, which stay unchanged. Those rules are HTTP 408,
409, 429 and 5xx (including Claude's 529), socket errors, and the Agents SDK replay flags.

| Kind | OpenAI | Claude |
|---|---|---|
| `quota_exhausted` | `insufficient_quota` | 402 `billing_error` |
| `authentication` | 401, `invalid_api_key` | 401 `authentication_error`, 403 `permission_error` |
| `model_unavailable` | none | 404 `not_found_error` (model not available to the org) |
| `input_too_large` | `context_length_exceeded` | 413 `request_too_large`, `model_context_window_exceeded`, or a 400 for a prompt over the window |
| `refused` | none | `ModelRefusal` |
| `backend_configuration` | none | a 400 naming an unknown beta, or a binding-control 400 |

- **`modelOutage`** today is `"unavailable" | "quota_exhausted"`. It gains `"refused"` as an additive union
  member, noted in the CHANGELOG, because a host that switches on it exhaustively must handle the new value.
- **The other new kinds** surface through the existing failure detail and MCP messages, not as new
  `modelOutage` values.

### 6. Snapshots and resume

- `MintAgentSnapshot` and `GuardianSessionSnapshot` gain `backend: {id, model}`.
- OpenAI snapshots stay `version: 1` with the field optional, so every existing snapshot is valid.
- Snapshots from any other backend are written as `version: 2`. Today's schema is `Literal(1)`, so an older
  host fails to decode them with a named reason instead of stripping the tag and resuming them as OpenAI.
- Resuming under a different backend fails with a named reason, and the host starts a fresh session.

### 7. Choosing a backend

- **CLI and MCP:** `--model-backend openai|anthropic`, default `openai`. `POMERADO_MODEL_BACKEND` is an alias.
- **Library:** `PomeradoOptions.modelBackend?: ModelBackend`, built by `openAIBackend()` or
  `anthropicBackend(options?)`. The per-agent `*Provider` options keep working and become the backend's
  `base`.
- **Keys:** the SDKs read keys from the environment.
  - Choosing `anthropic` checks at startup that `ANTHROPIC_API_KEY` is set, or that an `ant auth`
    credential resolves, and names the key if not.
  - `openai` gets no new check. Hosts with a custom client, a proxy or `setDefaultModelProvider` may have
    no key at all.
- **Dependency:** `@anthropic-ai/sdk` is an optional peer dependency, loaded with a dynamic import only when
  `anthropic` is chosen. If it's missing, startup fails with the install command.

### 8. Public API and host protocol

- **Additions only:**
  - `./core/models/backend` (interface, intent, features, failure kinds)
  - `./core/models/backends/openai`
  - `./core/models/backends/anthropic`
  - factory names `makeMinter`, `makeReviewer` and `makeOutcomeReviewer`, which take a backend
- **Nothing is renamed, deprecated or removed.** `makeOpenAIMinter` and the others stay as they are,
  equivalent to the new factories with the OpenAI backend, and `hostProtocol` stays 1.
- **One source of truth for TTL, comparison and diagnostics code.** That code is duplicated between
  `prompt-cache.ts` and `cached-instructions.ts`. The OpenAI backend is its single owner, and both modules
  keep re-exporting what they export today.

### 9. Prompts and docs

- `authoring/workspace/AGENTS.md` calls `apply_patch` "native". The wording becomes neutral, because the
  operations are identical on both backends.
- README, getting-started, agent-setup, how-it-works and the CLI help say an OpenAI **or** Anthropic key is
  needed, with a per-backend feature table.
- AGENTS.md's model-ID rule names `models.ts` for both providers.

## Testing decisions

- **What a good test is.** It drives a real Runner through a backend's provider over a recording `fetch`,
  then checks the wire request and the neutral result. It never checks private helpers. No test calls a
  real model.
- **Golden request fixtures (PR 0).** Full request bodies and headers, compared with `toStrictEqual`. They
  cover:
  - a mint build turn
  - mint prewarm, idle compaction, and the note after a provider compaction
  - a Guardian session with an effort change, compaction, the backstop path and prewarm
  - the outcome reviewer turn and prewarm

  The refactor must pass them byte for byte. Today's wire tests pin selected fields only, so they can't
  prove this alone.
- **Backend contract suite.** One parameterized suite runs both backends. It covers:
  - a tool round trip
  - parallel results in one message
  - consecutive-item merging
  - reasoning replay
  - the cached prefix
  - threshold compaction and the compaction item round trip
  - feature-gated paths with the feature off
  - effort from settings
  - structured output
  - `apply_patch` call and result
  - usage normalization
  - every failure kind, including a mid-stream refusal and the `max_tokens` stop
  - the beta-not-enabled 400
- **Schema subset.** Every minter, Guardian and outcome-reviewer schema converts. Inputs that violate the
  dropped constraints are rejected by client-side validation.
- **Append-only invariant.** As described in decision 3.
- **Pinned SDK assumption.** Under the Anthropic backend the SDK still selects the native `apply_patch` tool.
  This catches an SDK upgrade that would silently switch to its function-tool fallback.
- **Existing fixtures** (`mint-fixtures`, `guardian-context-fixture`, `standalone-mint-fixture`) keep working
  through the `*Provider` options. One end-to-end browser spec mints with `anthropicBackend()` over a
  scripted Anthropic `fetch`.
- **Startup, selection, snapshots:** CLI and MCP flags, the missing key and missing package errors, an old
  snapshot resuming on OpenAI, a cross-backend resume refused, and an old schema refusing a version 2
  snapshot.
- **Prior art:**
  - recording-fetch wire tests (`mint-request-layout`, `guardian-prompt-cache`, `guardian-reasoning-effort`)
  - scripted `apply_patch_call` (`mint-model-continuation`)
  - error shapes (`model-failure`)

## Out of scope for v1

These are follow-ups, each its own PR.

- **Claude server-side refusal fallbacks (`fallbacks: "default"`).** A fallback can route to a model that
  rejects per-message effort, sticks for about an hour, and changes the snapshot's model.
- Cache diagnostics, prewarm, on-demand background compaction and the per-message effort beta on Claude.
- Per-role model flags (`--minter-model`, `--reviewer-model`). This is a separate feature that also affects
  OpenAI users.
- Other providers (Gemini, Bedrock, Vertex, Foundry, OpenAI-compatible proxies) and the `aisdk()` adapter.
- Retuning prompts and skills for Claude. Quality is measured with live runs outside CI before anyone
  recommends Claude.
- Different backends for different roles in one build.

## Delivery

First, open an upstream issue with the problem, the solution and this plan, as CONTRIBUTING asks for larger
changes. Then land a stack of small PRs.

**Size targets.** Upstream's median merged PR is about 110 changed lines and the 90th percentile about 500.
So each PR here aims for 150 to 350 lines, tests included, and never goes much past 500. Golden fixture
JSON counts toward that.

**Each PR:**
- is green on its own
- has one purpose, stated in its title
- leaves OpenAI behavior byte-identical until PR 13 makes Claude selectable
- adds docs and a CHANGELOG entry only where public behavior changes

**Tests and the seam (no behavior change):**

1. **Golden fixtures for the minter.** Full request bodies for a build turn, prewarm, idle compaction, and
   the note after a provider compaction. Tests only.
2. **Golden fixtures for Guardian and the outcome reviewer.** Tests only.
3. **Model backend interface and OpenAI backend for the minter.** The minter's settings and request
   wrappers move into the backend without edits.
4. **The OpenAI backend for Guardian.**
5. **The OpenAI backend for the outcome reviewer.**
6. **Selecting a backend in the library.** `modelBackend` option, `makeMinter` / `makeReviewer` /
   `makeOutcomeReviewer` beside the existing factories, and feature-gated callers for background
   compaction, prewarm and cache diagnostics.
7. **Backend tag on snapshots.** Version 2 for snapshots from other backends, and the cross-backend
   refusal.
8. **Neutral failure kinds.** `classify` before the generic rules, and `refused` added to `modelOutage`.

**The Claude backend (dormant until PR 13):**

9. **Request conversion.** Instructions, messages, tool calls and results, system cache placement, effort
   and tool choice. Also the optional peer dependency.
10. **The Claude model and response reading.** The `Model` itself, output items, usage, refusal and
    truncation errors, and failure classification.
11. **Tool schemas.** Strict schema subset conversion and structured output.
12. **`apply_patch` on Claude.** Tool definition, V4A grammar, call and result mapping.
13. **Long context and switching it on.** Threshold compaction, thinking block binding, the append-only
    test, the CLI and MCP `--model-backend` flag, and the docs.

If a PR in this list runs over budget, it splits further. PRs 9 to 12 add code nothing calls yet, so each
one's description says which PR wires it in.

## Risks

- **V4A diffs on Claude.** Claude isn't trained on OpenAI's V4A patch format, so edits may fail more often.
  This is gated on a live evaluation before PR 3 merges. If it fails, the fallback is a Claude-native edit
  tool mapped onto the same `Editor`.
- **Build quality.** Prompts and skills are tuned for GPT models. A live comparison on a few real sites must
  come before the docs recommend Claude.
- **Classifier refusals.** Sign-in, CAPTCHA and payment-frame work may trigger refusals. v1 reports them
  plainly; fallbacks are a follow-up.
- **SDK coupling.** The design relies on the SDK selecting native `apply_patch` by constructor name. A
  pinned test covers it.

## Open questions

1. **Reviewer model on Claude.** `claude-opus-5-5` (draft), which keeps one model, one cache scope and the
   strongest reviewer? Or `claude-sonnet-5-5`, which is cheaper per token? Either way, Guardian's effort
   stays as configured.
2. **Is `drop_block` the right default** for users who bring their own key, or should a binding mismatch
   fail loudly (`"error"`) outside CI too? Draft: `drop_block` plus a recorded count.

## Change map (for review; paths may move)

- **New:** `src/models/backend.ts`, `src/models/backends/openai.ts`, `src/models/backends/anthropic/*`
  (model, conversion, tools and schema subset, usage, failures), tests for the golden fixtures, the
  contract suite and the append-only check.
- **Call sites that move into the OpenAI backend:**
  - `src/mint/openai.ts` (settings, `cacheLayout`, `afterProviderCompaction`, idle hooks)
  - `src/guardian/openai.ts`, `openai-input.ts`, `session.ts`
  - `src/mint/outcome-review-openai.ts`
- **Feature-gated callers:** `src/mint/idle-compaction.ts`, Guardian `compactBefore`, prewarm callers.
- **Snapshots:** `src/mint/recovery-contracts.ts`, `src/guardian/session.ts`.
- **Selection:** `src/standalone/contracts.ts`, `mint-host.ts`, `request-context.ts`, `cli.ts`,
  `mcp-cli.ts`, `mcp-jobs.ts`.
- **Models and failures:** `src/models/models.ts`, `model-failure.ts`, `provider-quota.ts`, `model-usage.ts`;
  `src/mint/contracts.ts` (`modelOutage`).
- **Docs:** `README.md`, `docs/*.md`, `AGENTS.md`, `CONTRIBUTING.md`, `authoring/workspace/AGENTS.md`,
  `CHANGELOG.md`, `package.json`.
