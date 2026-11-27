/**
 * The sharing rewrite makes no operation over constants that raises (lower/conservative/expr/share.ts
 * #raisesAsPlanned): PostgreSQL's planner folds an operation whose operands are constants wherever it stands, inside a
 * CASE arm no row reaches included (clauses.c eval_const_expressions), so a statement that holds `0 % 0` raises 22012
 * whatever rows it reads. A split of `e` on a guard `p` it reads twice substitutes p's values into `e`: a remainder of
 * two operands that are `CASE WHEN p THEN x ELSE 0 END` became `CASE WHEN p THEN x % x ELSE 0 % 0 END`, which the
 * optimized oracle's conservative SQL raised at over an empty relation (trunk red at 8627f750e,
 * test/pg/oracle/optimized/param-names under seed 2219874524, whose replayed case now passes).
 *
 * The box: a generated field of Gen (share.fixtures.ts installationOfTerm), a remainder guarded by its divisor being
 * nonzero (language.ts `divide`, mod) whose dividend and divisor are one conditional `CASE WHEN f BETWEEN lo AND hi
 * THEN f ELSE c END`, f a row's integer, lo and hi literals and c a literal, zero or not; the rewrite taken over the
 * guarded remainder whole, and over its remainder alone (the guard's THEN arm), each split the rewrite may take accepted
 * (a size that never refuses).
 *
 * Property, per case: the rewritten term holds no operation over constants, reading no column, VALUE or parameter,
 * whose host evaluation stops at a precondition its operands fail (scalar/compute/evaluate.ts EvalStop `undefined`),
 * where the term held none; and where c is not zero, the remainder alone is split. Oracle: specification, PostgreSQL
 * folds an operation over constants as it plans. Kill: a split is taken whatever constant it makes.
 *
 * Features: the remainder alone, the guarded remainder, a zero ELSE constant, a nonzero ELSE constant.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { constant as always, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { predicateTable, type ScalarExpr } from "#compiler/ir/expr.ts"
import { FieldTexts, sharedExpr } from "#compiler/lower/conservative/expr/share.ts"
import { closedLeaf } from "#compiler/runtime/write/fill.ts"
import { compiledExpr, type EvalLeaves, noParamLeaf } from "#compiler/scalar/compute/evaluate.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import type { NullTerm } from "#test/support/null/language.ts"
import {
	countedWorld,
	generatedExpr,
	installationOfTerm
} from "#test/unit/lower/conservative/share.fixtures.ts"

type Feature =
	| "the remainder alone"
	| "the guarded remainder"
	| "a zero ELSE constant"
	| "a nonzero ELSE constant"

/** A guarded remainder of one conditional by itself, and where the rewrite is taken over it. */
interface RaiseCase {
	readonly field: "n" | "m"
	readonly lo: number
	readonly hi: number
	readonly otherwise: number
	readonly over: "the remainder alone" | "the guarded remainder"
}

const raiseCaseGen: Gen<RaiseCase> = (s) => {
	const lo = s.draw(int(-9, 0))
	return {
		field: s.draw(element(["n", "m"] as const)),
		lo,
		hi: s.draw(int(lo, 9)),
		otherwise: s.draw(
			weighted([
				[2, always(0)],
				[1, always(1)],
				[1, always(2)]
			])
		),
		over: s.draw(element(["the remainder alone", "the guarded remainder"] as const))
	}
}

/** An integer literal. */
const intLit = (value: number): NullTerm => ({ t: "lit", literal: { sort: "int", value } })

/** The case's term: `x % x` guarded by `x <> 0`, x `CASE WHEN f BETWEEN lo AND hi THEN f ELSE c END`. */
const termOf = (rc: RaiseCase): NullTerm => {
	const f: NullTerm = { t: "field", field: rc.field }
	const x: NullTerm = {
		t: "cond",
		p: { p: "between", a: f, lo: intLit(rc.lo), hi: intLit(rc.hi) },
		a: f,
		b: intLit(rc.otherwise)
	}
	return { t: "divide", op: "mod", a: x, d: x, o: intLit(0) }
}

/** Whether `e` reads only constants: no column, VALUE, parameter or declared function's call. */
const constant = (e: ScalarExpr): boolean =>
	e.kind === "literal" ||
	(e.kind !== "column" &&
		e.kind !== "value" &&
		e.kind !== "param" &&
		e.kind !== "call" &&
		Arr.every(e.args, constant))

/**
 * The operations of `e` over constants whose host evaluation stops at a precondition their operands fail, each as
 * PostgreSQL's planner folds it and raises.
 */
const raisingConstants = (
	e: ScalarExpr,
	closed: EvalLeaves["closed"]
): ReadonlyArray<ScalarExpr> => {
	const own = ((): ReadonlyArray<ScalarExpr> => {
		if (e.kind === "literal" || !constant(e)) {
			return []
		}
		const table = predicateTable(e)
		const value = compiledExpr(table)(
			{ value: undefined, column: () => undefined, closed, param: noParamLeaf },
			ProgramPatterns.of(tablePatterns(table))
		)
		return !value.ok && value.error.kind === "undefined" ? [e] : []
	})()
	return [...own, ...Arr.flatMap(e.args, (a) => raisingConstants(a, closed))]
}

/** The sharing rewrite makes no operation over constants that raises as PostgreSQL plans it. */
export const theSharingRewriteMakesNoOperationOverConstantsThatRaisesAsPostgreSQLPlansIt =
	property.explore(raiseCaseGen, {
		needs: {},
		situations: [
			"the remainder alone",
			"the guarded remainder",
			"a zero ELSE constant",
			"a nonzero ELSE constant"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, k: Case<Feature>) => (rc) =>
			Effect.sync(() => {
				k.note(rc.over)
				k.note(rc.otherwise === 0 ? "a zero ELSE constant" : "a nonzero ELSE constant")
				const installation = installationOfTerm(countedWorld(1, 1), termOf(rc))
				const closed = closedLeaf(installation.names.closedIndex)
				const g = generatedExpr(installation, "g")
				const guarded = g.kind === "cond" ? g : assert.fail("g is the guarded remainder")
				const term = rc.over === "the guarded remainder" ? guarded : guarded.args[1]
				assert.deepEqual(raisingConstants(term, closed), [], "the term holds none")
				const rewritten = sharedExpr(term, {
					closed: installation.names.closedRelations,
					host: closed,
					size: () => 0,
					texts: new FieldTexts()
				})
				assert.deepEqual(
					raisingConstants(rewritten, closed),
					[],
					"the rewrite makes no operation over constants that raises"
				)
				if (rc.over === "the remainder alone" && rc.otherwise !== 0) {
					assert.equal(rewritten.kind, "cond", "the remainder alone is split on its guard")
				}
			}),
		oracle: {
			kind: "specification",
			name: "PostgreSQL folds an operation over constants as it plans"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/expr/share.ts",
				original: "\t\t\t\t\t(!this.#raisesAsPlanned(split) || this.#raisesAsPlanned(unsplit))\n",
				replacement: "\t\t\t\t\ttrue\n",
				why: "A split is taken whatever constant it makes, as it was: the remainder alone over a zero ELSE constant is split into `CASE WHEN p THEN x % x ELSE 0 % 0 END`, an operation over constants that raises, and the search fails."
			}
		]
	})
