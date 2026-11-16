/**
 * The hand-written scanners that replaced RegExp in the adapter when their packages met the dependency gate (no RegExp
 * construction, .test or .exec under src/): each is held to the regex it replaces over generated texts. Tests may use
 * RegExp; src may not.
 *
 * - Sqlstate.parse (core/sqlstate.ts) reads a text as a SQLSTATE exactly where /^[0-9A-Z]{5}$/ matches it, as the
 *   text itself, and refuses every other text.
 *
 * The oracle is a second implementation, the regex the scanner replaced. The texts are drawn by kind with explicit
 * weights: a code of the regex's own characters, its range edges among them; a code with one character just outside
 * those ranges (the neighbours of 0-9 and A-Z, a lowercase letter, an underscore, a space, a non-ASCII digit, a
 * fullwidth capital); a code a character short or long; and any text. Features: each kind, and a code read.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { Sqlstate } from "#compiler/core/sqlstate.ts"
import { assert } from "#test/support/assert.ts"
import { type Feature, reference, textGen } from "#test/unit/deps/scanners.fixtures.ts"

/**
 * Scanners that replace a RegExp under src: Sqlstate.parse reads exactly /^[0-9A-Z]{5}$/, as the text itself.
 *
 * Budget: its suite's count before the conversion (unit/deps/scanners-sqlstate: 2000 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const scannersThatReplaceARegExpUnderSrcSqlstateParseReadsExactly09AZ5AsTheTextItself =
	property.explore(textGen, {
		needs: {},
		situations: [
			"a code",
			"a character outside the code's",
			"a character short",
			"a character long",
			"any text",
			"a code read"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			(_, c: Case<Feature>) =>
			({ kind, text }) =>
				Effect.sync(() => {
					const parsed: string | undefined = Sqlstate.parse(text)
					const matches = reference.test(text)
					assert.equal(parsed, matches ? text : undefined, text)
					c.note(kind)
					if (matches) {
						c.note("a code read")
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "the RegExp /^[0-9A-Z]{5}$/ it replaced"
		},
		budget: { runs: 2000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/sqlstate.ts",
				original: "\t\tif (!((unit >= 0x30 && unit <= 0x39) || (unit >= 0x41 && unit <= 0x5a))) {",
				replacement:
					"\t\tif (!((unit >= 0x30 && unit <= 0x39) || (unit >= 0x41 && unit <= 0x59))) {",
				why: "Sqlstate.parse's range of capitals ends at Y; the property fails."
			},
			{
				file: "packages/engine/src/core/sqlstate.ts",
				original:
					"\t\tif (!((unit >= 0x30 && unit <= 0x39) || (unit >= 0x41 && unit <= 0x5a))) {\n\t\t\treturn undefined\n\t\t}",
				replacement: "\t\t{}",
				why: "Operator mutant (guard) at packages/engine/src/core/sqlstate.ts:34 in parse: `if (!((unit >= 0x30 && unit <= 0x39) || (unit >= 0x41 && unit <= 0x5a))) {\n\t\t\tre` becomes `{}`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
