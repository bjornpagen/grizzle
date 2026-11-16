import { dictionary } from "@bjornpagen/testing/dictionary"
import { nonEmpty } from "#test/support/assert.ts"
import { documentedTexts } from "#test/support/refusals.ts"

/**
 * Every text the refusal table documents (packages/grizzle/src/cli/refusals.ts): each refusal's problem and fix, each
 * applied-edit phrase of migrate and each stage's fix. The table is the domain, never cases a person chose.
 */
export const documented = dictionary(
	nonEmpty(documentedTexts(), "the refusal table documents texts")
)
