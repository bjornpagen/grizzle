/** What the property of resolve-reference.test.ts reads: its batches and its SQL. */

import { assert } from "@bjornpagen/testing/assert"
import { array, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter } from "effect"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { predicateTable } from "#compiler/ir/expr.ts"
import { libraryCreate } from "#compiler/physical/ddl/library.ts"
import { compiledExpr, noParamLeaf } from "#compiler/scalar/compute/evaluate.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { succeeded } from "#test/support/assert.ts"
import { baseParams, lowerWith, plainRender, renderSql } from "#test/unit/compute/support.ts"
import { textColumn } from "#test/unit/compute/text.fixtures.ts"
import { referenceCaseGen, rfcExamples, type UriFeature } from "#test/unit/text/uri.fixtures.ts"

/** One reference against one base. */
export interface Pair {
	readonly base: string
	readonly reference: string
}

/** A batch: RFC 3986 §5.4's 42 examples, then up to 48 drawn references, each against a drawn base. */
export const pairsBatch: Gen<{
	readonly pairs: Arr.NonEmptyReadonlyArray<Pair>
	readonly features: ReadonlyArray<UriFeature>
}> = (source) => {
	const drawn = source.draw(array(referenceCaseGen, { min: 0, max: 48 }))
	return {
		pairs: [...rfcExamples, ...drawn],
		features: Arr.dedupe(Arr.flatMap(drawn, (d) => d.features))
	}
}

const resolved: ExprDesc = {
	kind: "compute",
	fn: "resolveReference",
	args: [
		{ kind: "var", var: "b" },
		{ kind: "var", var: "r" }
	]
}

/** computeCore.resolveReference(b, r) as a check lowers it. */
const term = succeeded(
	lowerWith("check", resolved, { b: textColumn, r: textColumn }, false, baseParams),
	"computeCore.resolveReference lowers in a check over any texts"
).root

/** The library function's CREATE in the session's pg_temp, where the term's SQL calls it (support.ts temporaryLibrary). */
export const createLibrary = printStatement(libraryCreate("pg_temp", "resolveReference"))

/** The term's SQL over a batch's pairs, `$1` their JSON, in their order: PostgreSQL's target of each. */
export const resolveSql = `SELECT (${renderSql(term.expr, plainRender)})::text FROM jsonb_to_recordset($1::text::jsonb) AS r0(ord int4, b text, r text) ORDER BY r0.ord`

/** The host evaluator's target of a pair (scalar/compute/evaluate.ts), over the term the SQL holds. */
export const hostTarget = ({ base, reference }: Pair): string => {
	const table = predicateTable(term.expr)
	const value = succeeded(
		compiledExpr(table)(
			{
				value: undefined,
				column: (ref) => (ref.name === "b" ? base : reference),
				closed: () => undefined,
				param: noParamLeaf
			},
			ProgramPatterns.of(tablePatterns(table))
		),
		"the host evaluates resolveReference"
	)
	return typeof value === "string"
		? value
		: assert.fail(`the host's target is a text, not ${Formatter.format(value)}`)
}
