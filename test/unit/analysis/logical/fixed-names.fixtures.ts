/** What fixed-names.test.ts reads: the DAG of a case, a filter of equalities naming a relation's columns. */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { defined } from "@bjornpagen/testing/assert"
import { type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { makeIdSupply, ParamId } from "#compiler/core/ids.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import { type DefinedOp, type ScalarExpr, storedColumn } from "#compiler/ir/expr.ts"
import { conservativeMeta, type Heading, type ValidDag, type VarDecl } from "#compiler/ir/rel.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import { bool, int8 } from "#test/support/oracle/gen/domain.ts"
import { andOp, compareOpId } from "#test/support/oracle/gen/ops.ts"

/** A case: how many equalities chain the columns, a to b and on, and how many parameters name the chain's columns too. */
export interface Chain {
	readonly links: number
	readonly names: number
}

export const chainGen: Gen<Chain> = (source) => ({
	links: source.draw(int(1, 3)),
	names: source.draw(int(0, 2))
})

/** The terms a filter of a region's columns states its conjuncts in (`filteredRegion`). */
interface Terms {
	readonly column: (name: string) => ScalarExpr
	readonly literal: (value: bigint) => ScalarExpr
	readonly param: (name: string) => ScalarExpr
	readonly eq: (left: ScalarExpr, right: ScalarExpr) => ScalarExpr
}

/**
 * The DAG of a relation of bigint `columns`, keyed by the first, its region binding each to a variable of its own,
 * under a filter of the conjuncts `conjuncts` states over its terms. A filter's equality of two columns gives each the
 * names the other holds only once the other holds them, so the names of a chain read from its far end take a round a
 * link. A rule's equality of two of its variables is one class of its region instead (check/checker.ts RuleCheck
 * #equated), whose names settle in one round, so a chain of the filter's is built as the DAG it is: where a rewrite
 * leaves equalities of columns, a condition moved over a projection or a join.
 */
const filteredRegion = (
	columns: NonEmptyReadonlyArray<string>,
	conjuncts: (t: Terms) => NonEmptyReadonlyArray<ScalarExpr>
): ValidDag => {
	const b = new DagBuilder(makeIdSupply())
	const heading: Heading = Arr.map(columns, (name) => ({ name, type: int8 }))
	const base = b.node({
		kind: "Base",
		relation: "R",
		occurrence: b.ids.occurrence(),
		primaryKey: [columns[0]],
		keys: [],
		relationKind: "relation",
		generated: [],
		unit: [],
		determined: [],
		heading,
		loc: undefined,
		meta: conservativeMeta
	})
	const vars = Arr.map(columns, (name): VarDecl => ({ id: b.ids.var(), name, type: int8 }))
	const region = b.node({
		kind: "MatchRegion",
		scope: b.ids.scope(),
		vars,
		occurrences: [
			{
				id: b.ids.occurrence(),
				source: base,
				bindings: Arr.map(vars, (v) => ({ column: v.name, var: v })),
				constants: []
			}
		],
		equalities: [],
		correlated: [],
		heading,
		loc: undefined,
		meta: conservativeMeta
	})
	const op = (fn: DefinedOp, args: ReadonlyArray<ScalarExpr>): ScalarExpr =>
		b.expr({ kind: "op", op: fn, args, type: bool, nonNull: "strict", volatility: "immutable" })
	const terms: Terms = {
		column: (name) => b.expr(storedColumn(region.id, name, int8)),
		literal: (value) =>
			b.expr({
				kind: "literal",
				value: { kind: "int", value },
				args: [],
				type: int8,
				nonNull: "literal"
			}),
		param: (name) =>
			b.expr({
				kind: "param",
				param: ParamId(name),
				role: "compare",
				args: [],
				type: int8,
				nonNull: "codec"
			}),
		eq: (left, right) => op(compareOpId(int8, "eq"), [left, right])
	}
	const [first, ...rest] = conjuncts(terms)
	const filter = b.node({
		kind: "Filter",
		input: region,
		pred: Arr.reduce(rest, first, (conjunction, conjunct) => op(andOp, [conjunction, conjunct])),
		heading,
		loc: undefined,
		meta: conservativeMeta
	})
	return validateDag(b.build([filter]))
}

/**
 * The case's DAG: R's columns a, b, c and d under a filter of each of the first `links` columns equal to the next, the
 * last of them 5, and each of the first `names` of them, from the last back, equal to a parameter of its own
 * (`filteredRegion`).
 */
export const chainDag = (chain: Chain): ValidDag => {
	const chained = Arr.take(["a", "b", "c", "d"], chain.links + 1)
	const last = defined(chained[chain.links], "a chain's last column")
	return filteredRegion(["a", "b", "c", "d"], (t) =>
		Arr.appendAll(
			Arr.append(
				Arr.map(Arr.zip(chained, Arr.drop(chained, 1)), ([x, y]) => t.eq(t.column(x), t.column(y))),
				t.eq(t.column(last), t.literal(5n))
			),
			Arr.map(Arr.take(Arr.reverse(chained), chain.names), (name, j) =>
				t.eq(t.column(name), t.param(`p${j}`))
			)
		)
	)
}

/**
 * The DAG of a relation of m columns, c0 to c(m − 1), under a filter of each equal to the next and each equal to a
 * parameter of its own (`filteredRegion`): every column holds every parameter's name, each reached through the
 * equalities from its own column, so a column is offered each of m names by each equality it is read through.
 */
export const namedChainDag = (m: number): ValidDag => {
	const columns = Arr.prepend(
		Array.from({ length: m - 1 }, (_, i) => `c${i + 1}`),
		"c0"
	)
	return filteredRegion(columns, (t) =>
		Arr.prependAll(
			Arr.map(columns, (c, j) => t.eq(t.column(c), t.param(`p${j}`))),
			Arr.map(Arr.zip(columns, Arr.drop(columns, 1)), ([x, y]) => t.eq(t.column(x), t.column(y)))
		)
	)
}
