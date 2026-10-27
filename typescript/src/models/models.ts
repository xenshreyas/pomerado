/** The only place model IDs are named in `typescript/src` and `tools`, and tests name the
 * current models only through these constants, both enforced by
 * `typescript/tests/unit/model-ids.test.ts`; changing a model is a one-line edit here. */

/** The big model: minting, maintenance, example generation and challenge solving. */
export const solModel = "gpt-6.1-sol";

/** The small model: Guardian reviews and capability assessment. */
export const lunaModel = "gpt-6-luna";

/** The minter's model on the Claude backend. */
export const claudeMinterModel = "claude-opus-5-5";

/** Guardian's and the outcome reviewer's model on the Claude backend. */
export const claudeReviewerModel = "claude-opus-5-5";
