/**
 * Nothing in grizzle's tree spells its API as it was spelt before PostgreSQL's names (old-names.fixtures.ts): no
 * member of the pg namespace, no name gone from every entry, no old name read off an entry's namespace or imported from
 * a public module, no contract entry, and in a document no code span of an old name and no word of a name's history.
 * The documents (README, CONTRIBUTING, SKILL and docs/), the tests and the benchmarks are read whole, so a program a
 * test builds as a string is held as a module is; the codemod that rewrites a consumer's old spellings
 * (scripts/dev/star-imports.sh and its plugin) is no file of the scan, since spelling them is its job.
 *
 * Oracle: the specification, the old spellings Bjorn's cutover deletes, read over the checkout's files.
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { oldNameFiles } from "#test/unit/dev/old-names.dictionary.ts"
import { oldSpellingsOf } from "#test/unit/dev/old-names.fixtures.ts"

/** No file of the documents, the tests or the benchmarks holds an old spelling of grizzle's API. */
export const noFileSpellsGrizzlesApiAsItWasSpeltBefore = property.exhaust(oldNameFiles, {
	box: "every document, test module and benchmark module of the checkout, the scan's own modules apart",
	needs: { checkout: Checkout.dir },
	situations: [],
	check: (resources) => (file) =>
		Effect.gen(function* () {
			const checkout = yield* resources.checkout
			const spellings = yield* oldSpellingsOf(checkout, file)
			assert.deepEqual(spellings, [])
		}),
	oracle: {
		kind: "specification",
		name: "the old spellings the cutover deletes, read over the checkout's files"
	},
	show: (file) => file,
	kept: [],
	kills: [
		{
			file: "README.md",
			original: "export const feed = g.query(Member).rule((r) => {",
			replacement: "export const feed = g.query(Member).rule((r) => { const old = pg.integer",
			why: "A README block reads the pg namespace's integer, a name the root exports as int4: the reference spells the API as it was."
		},
		{
			file: "test/support/agreement/changesets.ts",
			original: '\t\t\t\t\t\t"export type Expect<T extends true> = T",',
			replacement: '\t\t\t\t\t\t"export type Expect<T extends true> = T // typeof pg.bigint",',
			why: "A program a test builds as a string reads the pg namespace, which tsgo then reports as no name: an embedded old spelling the scan must find as it finds one in a module."
		}
	]
})
