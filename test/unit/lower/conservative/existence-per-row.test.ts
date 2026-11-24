/**
 * An existence test reads its right side per left row where that side is more than a scan of one source and its join
 * columns restrict every relation it reads (lower/conservative/semi-join/exists.ts): a step correlated inside it, the
 * right side's rows at the left row with the join's equalities inside the step, read apart by the one printer of a step
 * (lower/conservative/step fencedRead, OFFSET 0), and the test's own condition empty, so PostgreSQL never pulls it up. In
 * a bare NOT EXISTS, PostgreSQL pulls such a side up into the anti-join and plans the parameterizations of every subset
 * of its relations by the left side's: on edullm's ledger grade write (KDL-runtime, grizzle 3821324d3) an anti-join on
 * six key columns over 56 relations planned in 17 s, the statement's 32 such reads past 8.5 minutes and 43.8 GB.
 *
 * The box, exhausted: a negation of a query over one relation, over a join of two, over a fold by the negation's keys,
 * over a fold whose count the negation binds, and over a fold at the statement's value, which it restricts.
 *
 * Oracle: specification, the rule: the join and the fold by its keys are read per left row, the NOT EXISTS over a step
 * whose WHERE holds the join's equalities and no condition of its own; the scan of one source stays in a bare NOT
 * EXISTS, its equalities its own condition, which PostgreSQL probes per left row through its index, and so does the
 * fold whose count is bound, a column no relation it reads holds, past which a fixed value would derive the fold whole
 * for each row, and the fold the statement's value restricts, small derived once, which a step per left row would fold
 * again for each (edullm's PERF-COMMIT submit at 100x: the call's previous attempts, 20 rows, folded again for each of
 * 1,650,480 processed attempts, 11.3 s).
 *
 * Features: a right side read per left row; a right side left in NOT EXISTS.
 */

import { assert } from "@bjornpagen/testing/assert"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { natural, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"

const A = relation("A", { k1: pg.integer, k2: pg.integer, v: natural }, ["k1", "k2"])
const B = relation("B", { k1: pg.integer, k2: pg.integer, x: pg.integer }, ["k1", "k2", "x"])
const C = relation("C", { k1: pg.integer, k2: pg.integer, y: pg.integer }, ["k1", "k2", "y"])
const S = schema("ExistencePerRow", [A, B, C], [])

type Shape =
	| "a scan of one source"
	| "a join of two sources"
	| "a fold by the negation's keys"
	| "a fold whose count is bound"
	| "a fold at the statement's value"

type Feature = "a right side read per left row" | "a right side left in NOT EXISTS"

const scanned = query(S).rule((r) => {
	const { k1, k2, x } = v(B, "b")
	return r.match(B, { k1, k2, x }).where(r.gt(x, 0)).find({ k1, k2 })
})

const joined = query(S).rule((r) => {
	const { k1, k2, x } = v(B, "b")
	const { y } = v(C, "c")
	return r.match(B, { k1, k2, x }).match(C, { k1, k2, y }).find({ k1, k2 })
})

const folded = query(S).rule((r) => {
	const { k1, k2, x } = v(B, "b")
	return r.match(B, { k1, k2, x }).find({ k1, k2, n: r.count() })
})

/** The fold by the keys at the asked k1, a fold the statement's value restricts: its rows few, derived once. */
const foldedAt = query(S).rule((r) => {
	const { k1, k2, x } = v(B, "b")
	return r
		.match(B, { k1, k2, x })
		.where(r.eq(k1, r.param("k", pg.integer)))
		.find({ k1, k2, n: r.count() })
})

/** The rows of A no fact of the right side matches, by the shape's bindings. */
const negated = (shape: Shape) =>
	query(S).rule((r) => {
		const { k1, k2, v: value } = v(A, "a")
		const matched = r.match(A, { k1, k2, v: value })
		switch (shape) {
			case "a scan of one source":
				return matched.where(r.not(scanned, { k1, k2 })).find({ k1, k2 })
			case "a join of two sources":
				return matched.where(r.not(joined, { k1, k2 })).find({ k1, k2 })
			case "a fold by the negation's keys":
				return matched.where(r.not(folded, { k1, k2 })).find({ k1, k2 })
			case "a fold whose count is bound":
				return matched.where(r.not(folded, { k1, n: value })).find({ k1, k2 })
			case "a fold at the statement's value":
				return matched
					.where(r.not(foldedAt.bind({ k: r.param("k", pg.integer) }), { k1, k2 }))
					.find({ k1, k2 })
		}
	})

/** How a test reads its right side: a step correlated inside it, a bare test, or neither. */
type TestForm = "a step correlated inside it" | "a bare test" | "neither"

/**
 * Each character of `sql` with its parenthesis depth before it and whether it stands inside a quoted name or literal,
 * where a parenthesis moves nothing.
 */
const depths = (
	sql: string
): ReadonlyArray<{ readonly c: string; readonly depth: number; readonly quoted: boolean }> => {
	const out: Array<{ readonly c: string; readonly depth: number; readonly quoted: boolean }> = []
	let depth = 0
	let quote: string | undefined
	for (const c of sql) {
		out.push({ c, depth, quoted: quote !== undefined })
		if (quote !== undefined) {
			quote = c === quote ? undefined : quote
		} else if (c === "'" || c === '"') {
			quote = c
		} else if (c === "(") {
			depth++
		} else if (c === ")") {
			depth--
		}
	}
	return out
}

/** `sql` with every parenthesized part cut out: the clauses of its own level. */
const ownLevel = (sql: string): string =>
	Arr.join(
		Arr.map(
			Arr.filter(depths(sql), (d) => d.depth === 0 && (d.quoted || (d.c !== "(" && d.c !== ")"))),
			(d) => d.c
		),
		""
	)

/** The text inside the parenthesis `sql` opens with, and the text after its close. */
const parenthesized = (sql: string): { readonly inside: string; readonly after: string } => {
	const marked = depths(sql)
	const close = Arr.findFirstIndex(
		marked,
		(d, i) => i > 0 && !d.quoted && d.depth === 1 && d.c === ")"
	)
	return Option.match(close, {
		onNone: () => ({ inside: sql, after: "" }),
		onSome: (at) => ({ inside: Str.slice(1, at)(sql), after: Str.slice(at + 1)(sql) })
	})
}

/**
 * The form of the statement's one NOT EXISTS: `SELECT 1 FROM (<inner>) AS s(…)` with no condition of its own over an
 * inner query fenced by OFFSET 0 whose own WHERE holds the join's equalities, a step correlated inside it; `SELECT 1
 * FROM (<right>) AS r(…) WHERE <equalities>` over an unfenced right side, a bare test; anything else, neither.
 */
const testOf = (sql: string): TestForm => {
	const [, tail, ...more] = Str.split("NOT EXISTS ")(sql)
	const prefix = "SELECT 1 FROM "
	if (tail === undefined || more.length > 0) {
		return "neither"
	}
	const body = parenthesized(tail).inside
	if (!Str.startsWith(prefix)(body)) {
		return "neither"
	}
	const { inside, after } = parenthesized(Str.slice(prefix.length)(body))
	const fence = ownLevel(inside)
	const fenced = Str.endsWith("OFFSET 0")(Str.trimEnd(fence))
	const own = Str.includes("WHERE")(ownLevel(after))
	if (fenced && !own && Str.includes("WHERE")(fence)) {
		return "a step correlated inside it"
	}
	return !fenced && own ? "a bare test" : "neither"
}

/** Whether the shape's right side is read per left row, by the rule. */
const perRow = (shape: Shape): boolean =>
	shape === "a join of two sources" || shape === "a fold by the negation's keys"

/**
 * An existence test reads a right side of several sources or a fold by its keys per left row, a step correlated inside it
 * at the row's keys.
 */
export const anExistenceTestReadsARightSideOfSeveralSourcesOrAFoldByItsKeysPerLeftRowAStepCorrelatedInsideItAtTheRowsKeys =
	property.exhaust(
		finite((source) =>
			source.draw(
				element<Shape>([
					"a scan of one source",
					"a join of two sources",
					"a fold by the negation's keys",
					"a fold whose count is bound",
					"a fold at the statement's value"
				])
			)
		),
		{
			needs: {},
			situations: ["a right side read per left row", "a right side left in NOT EXISTS"],
			check: (_, k: Case<Feature>) => (shape) =>
				Effect.sync(() => {
					const template = succeeded(compileTemplate(negated(shape), undefined, testCompile))
					const sql = Arr.join(
						Arr.map(template.conservative, (s) => s.sql),
						"\n"
					)
					assert.equal(
						testOf(sql),
						perRow(shape) ? "a step correlated inside it" : "a bare test",
						`${shape}: the right side read per left row\n${sql}`
					)
					k.note(
						perRow(shape) ? "a right side read per left row" : "a right side left in NOT EXISTS"
					)
				}),
			oracle: {
				kind: "specification",
				name: "a right side of several sources, or a fold by the keys, is read per left row, a step correlated inside its NOT EXISTS; a scan of one source, a fold whose count is bound and a fold the statement's value restricts stay in a bare NOT EXISTS"
			},
			box: "a negation of a query over one relation, a join of two, a fold by its keys, a fold whose count it binds, and a fold at the statement's value",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/conservative/semi-join/exists.ts",
					original: '\tcostClass(node.right) !== "scan" &&\n',
					replacement: "\tfalse &&\n",
					why: "Every right side stays in a bare NOT EXISTS, as before: the join and the fold by the keys are tested there, which PostgreSQL pulls up and plans every parameterization of, and the property fails."
				},
				{
					file: "packages/engine/src/lower/conservative/semi-join/exists.ts",
					original:
						"fencedRead(headingTargets(node.right.heading, right.map), right.item, conjunction(on)),",
					replacement:
						"fencedRead(headingTargets(node.right.heading, right.map), right.item, undefined),",
					why: "The step reads the right side at no left row: its equalities dropped, the test asks whether the right side holds any row at all, and the property fails."
				},
				{
					file: "packages/engine/src/lower/conservative/semi-join/exists.ts",
					original: "\trestrictedByKeys(\n",
					replacement: "\t(() => true)(\n",
					why: "A right side is read per left row though a join column stops at its fold's count: the fold whose count is bound is derived whole for each left row, and the property fails."
				},
				{
					file: "packages/engine/src/lower/conservative/semi-join/exists.ts",
					original: "\t!restrictedWithin(node.right, node) &&\n",
					replacement: "",
					why: "A right side the statement's value restricts is read per left row too, as 2bdab1f6f's did: the fold at the asked k1, a few rows, folded again for each row of A, where it is derived once and each of its rows probes A."
				},
				{
					file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
					original: "\t\t\t\t\tvalueEqualities(node).length > 0 ||\n",
					replacement: "\t\t\t\t\tfalse ||\n",
					why: "A filter at the statement's value restricts nothing, as before: the fold at the asked k1, whose filter the checked DAG keeps above the fold's region, counts as unrestricted and is read per left row."
				}
			]
		}
	)
