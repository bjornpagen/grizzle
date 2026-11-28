/** What bounded.test.ts reads: its case space, the guarded match it lowers, and what each row reaches. */

import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { assert, defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { spelled } from "#test/support/fixtures/ir/scalar.ts"
import {
	baseParams,
	lowerWith,
	plainRender,
	renderSql
} from "#test/support/unit/compute/support.ts"
import { textColumn } from "#test/support/unit/compute/text.fixtures.ts"
import { admittedPatternOver, families, stringsOver } from "#test/support/unit/text/generators.ts"

/** One case: a family's pattern, the most bytes the guard admits, and the texts the query reads, in order. */
export interface BoundedCase {
	readonly pattern: string
	readonly bytes: number
	readonly texts: Arr.NonEmptyReadonlyArray<string>
}

/** What a row of a case reaches. */
export type BoundedFeature =
	| "a match held within the bound"
	| "a match failed within the bound"
	| "a text past the bound, the program's false"

export const boundedFeatures: ReadonlyArray<BoundedFeature> = [
	"a match held within the bound",
	"a match failed within the bound",
	"a text past the bound, the program's false"
]

/**
 * A case over one of the text families: a pattern admitted over its alphabet, a bound of a few bytes, and texts over
 * the alphabet up to twelve characters, so a batch holds texts within the bound and past it.
 */
export const boundedCase: Gen<BoundedCase> = (source) => {
	const family = defined(families[source.draw(int(0, families.length - 1))], "a family")
	const strings = stringsOver(element(family.alphabet), 12)
	const first = source.draw(strings)
	const rest = source.draw(array(strings, { min: 0, max: 47 }))
	return {
		pattern: source.draw(admittedPatternOver(family.alphabet)),
		bytes: source.draw(int(0, 24)),
		texts: [first, ...rest]
	}
}

/**
 * Logic.when(Num.within(Text.octetLength(v), 0, bytes), () => Text.matches(v, pattern), false): a match
 * guarded by the text's bytes, the program's answer false past them.
 */
const guardedMatch = (pattern: string, bytes: number): ExprDesc => ({
	kind: "when",
	guard: { kind: "within", low: 0, high: bytes },
	subject: { kind: "compute", fn: "octetLength", args: [{ kind: "var", var: "v" }] },
	proved: {
		kind: "compute",
		fn: "matches",
		args: [
			{ kind: "var", var: "v" },
			{ kind: "literal", value: spelled(pattern) }
		]
	},
	otherwise: { kind: "literal", value: false }
})

/** The guarded match lowered as a query's predicate over `v`, text whose type bounds no bytes, and its SQL. */
export const loweredInQuery = (
	c: BoundedCase
): { readonly expr: ScalarExpr; readonly sql: string } => {
	const lowered = lowerWith(
		"query",
		guardedMatch(c.pattern, c.bytes),
		{ v: textColumn },
		true,
		baseParams
	)
	if (!lowered.ok) {
		return assert.fail(
			`a match of /${c.pattern}/u guarded within ${c.bytes} bytes lowers in a query over text of no byte bound: ${lowered.error.message}`
		)
	}
	const expr = lowered.value.root.expr
	return { expr, sql: renderSql(expr, plainRender) }
}

/** Whether a text lies within the guard's bytes, where the program reads the match. */
export const withinBound = (text: string, bytes: number): boolean => utf8Length(text) <= bytes
