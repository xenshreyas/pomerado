/**
 * One request's needs in neutral terms, which each model backend turns into its provider's own
 * request. An in-process value: it is never serialized and never sent.
 */
export interface ModelIntent {
  readonly effort: "low" | "medium";
  readonly continuity: boolean;
  readonly parallelToolCalls: boolean;
  readonly cache?: { readonly key?: string; readonly compareWith?: string };
  readonly offeredTools?: readonly string[];
  readonly compactAtTokens?: number;
  readonly prewarm?: boolean;
}
