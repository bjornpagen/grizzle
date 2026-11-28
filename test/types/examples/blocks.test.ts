/**
 * README.md's and packages/grizzle/skills/grizzle/SKILL.md's ```ts blocks are checked code. Each block is mirrored, line
 * for line and in order, in a fixture of test/types/examples: README.md's in exactly one of fixtures/readme.ts (what
 * grizzle compiles) and fixtures/readme.app.ts (the application), SKILL.md's in fixtures/skill.ts. `pnpm typecheck`
 * checks the fixtures as they stand, examples.test.ts the README's refusals and generates.test.ts its programs, and this
 * property holds every block to its fixture (blocks.fixtures.ts): its lines found in one fixture in order, no # subpath
 * import, every imported name imported or bound by that fixture, and every served file declared. So an edit to a block
 * alone fails here, and an edit that breaks a mirrored line fails the typecheck. Oracle: the documentation's fixtures,
 * the programs the documented lines stand in.
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { documentedBlocks } from "#test/types/examples/blocks.dictionary.ts"
import { blockMismatches } from "#test/types/examples/blocks.fixtures.ts"

/** Each documented block is mirrored, line for line and in order, in the typechecked examples fixtures. */
export const mirrored = property.exhaust(documentedBlocks, {
	box: "every ts block of README.md and SKILL.md",
	needs: { checkout: Checkout.dir },
	situations: [],
	check: (resources) => (block) =>
		Effect.gen(function* () {
			const checkout = yield* resources.checkout
			const mismatches = yield* blockMismatches(checkout, block)
			assert.deepEqual(mismatches, [])
		}),
	oracle: {
		kind: "specification",
		name: "the documentation's fixtures, the programs its lines stand in"
	},
	show: (block) => `${block.mirror.doc} block ${block.at + 1}`,
	kept: [],
	kills: [
		{
			file: "README.md",
			original: "export const feed = g.query(Member).rule((r) => {",
			replacement: "export const feeds = g.query(Member).rule((r) => {",
			why: "A README block's binding renamed where its fixture keeps the old name, so the block's line is mirrored nowhere."
		}
	]
})
