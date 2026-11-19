/**
 * An expression's one structural walk (ir/desc.ts exprChildren and mapExpr) and the walks over it, over generated
 * expressions of every kind, each holding imports whose bind maps read the expression's own variables and parameters
 * and whose queries hold their own.
 *
 * - Leaves: the variables and parameters a walk finds an expression reading in its own scope (analysis/theory/leaves.ts
 *   varsOf, check/scan.ts leavesOf) are every variable and parameter its description holds outside the queries it
 *   imports, a bind map's among them, and a rewrite of its variables or its parameters (mapLeaves, boundIn) replaces
 *   each of them and none of an imported query's.
 * - Children: each node's children are the terms its description holds in its own scope, in the order it states them,
 *   and a map of its children replaces each of them, a bind map's terms among them, and nothing else.
 *
 * Oracle: a second implementation, the description's own values walked as data, by no kind's spelling.
 *
 * Features: every kind of expression held, a variable and a parameter only a bind map reads, a relation parameter a
 * bind map binds, and an imported query's own variable.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { boundIn, mapLeaves, varsOf } from "#compiler/analysis/theory/leaves.ts"
import { leavesOf } from "#compiler/check/scan.ts"
import { exprChildren, type InferredExpr, mapExprChildren } from "#compiler/ir/desc.ts"
import {
	bindOnly,
	directTerms,
	exprKinds,
	exprs,
	type Feature,
	kindsIn,
	leafNames
} from "#test/unit/ir/walk.fixtures.ts"

const sorted = (names: Iterable<unknown>): ReadonlyArray<string> =>
	Arr.sort(Arr.map(Arr.fromIterable(names), String), Str.Order)

const noted = (e: InferredExpr, c: Case<Feature>): void => {
	for (const kind of exprKinds) {
		if (kindsIn(e).has(kind)) {
			c.note(`holds ${kind}`)
		}
	}
	if (bindOnly(e, "var").size > 0) {
		c.note("a variable only a bind map reads")
	}
	if (bindOnly(e, "param").size > 0) {
		c.note("a parameter only a bind map reads")
	}
	if (leafNames(e, "relationParam", true).size > 0) {
		c.note("a relation parameter bound")
	}
	if (leafNames(e, "var", false).size > 0) {
		c.note("an import's own variable")
	}
}

const situations: ReadonlyArray<Reached<Feature>> = [
	...Arr.map(exprKinds, (kind) => `holds ${kind}` as const),
	"a variable only a bind map reads",
	"a parameter only a bind map reads",
	"a relation parameter bound",
	"an import's own variable"
]

/**
 * The variables and parameters an expression reads in its own scope are every one its description holds outside the
 * queries it imports, a bind map's among them, and a rewrite of its variables or parameters replaces each of them and
 * none of an imported query's.
 *
 * Budget: 300 runs and 1000 steered cases, enough for the steered phase to reach a bind map's variable and parameter
 * beside every kind.
 */
export const anExpressionReadsEveryVariableAndParameterItsDescriptionHoldsOutsideTheQueriesItImportsABindMapsAmongThemAndARewriteReplacesEachOfThem =
	property.explore(exprs, {
		needs: {},
		budget: { runs: 300, steered: 1000 },
		situations,
		check: (_, c: Case<Feature>) => (e) =>
			Effect.sync(() => {
				noted(e, c)
				const vars = sorted(leafNames(e, "var", true))
				const params = sorted(leafNames(e, "param", true))
				assert.deepEqual(sorted(varsOf(e, new Set())), vars, "varsOf reads every own variable")
				const leaves = leavesOf(e)
				assert.deepEqual(sorted(leaves.vars), vars, "leavesOf reads every own variable")
				assert.deepEqual(
					sorted(new Set(Arr.map(leaves.params, (p) => p.name))),
					sorted(new Set([...params, ...leafNames(e, "relationParam", true)])),
					"leavesOf reads every own parameter, a bind map's relation parameters among them"
				)
				const renamed = mapLeaves(e, {
					var: (id) => ({ kind: "var", var: `renamed.${id}` }),
					field: () => undefined
				})
				assert.deepEqual(
					sorted(leafNames(renamed, "var", true)),
					sorted(Arr.map(vars, (v) => `renamed.${v}`)),
					"mapLeaves renames every own variable"
				)
				assert.deepEqual(
					sorted(leafNames(renamed, "var", false)),
					sorted(leafNames(e, "var", false)),
					"mapLeaves renames no imported query's variable"
				)
				const rebound = boundIn(
					e,
					new Map(Arr.map(params, (p) => [p, { kind: "var", var: `bound.${p}` }] as const))
				)
				assert.deepEqual(
					sorted(leafNames(rebound, "param", true)),
					[],
					"boundIn replaces every own parameter"
				)
				assert.deepEqual(
					sorted(leafNames(rebound, "var", true)),
					sorted([...vars, ...Arr.map(params, (p) => `bound.${p}`)]),
					"boundIn binds each own parameter to its term"
				)
				assert.deepEqual(
					sorted(leafNames(rebound, "param", false)),
					sorted(leafNames(e, "param", false)),
					"boundIn replaces no imported query's parameter"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the description's own values walked as data: every variable and parameter object outside an imported query's"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/ir/walk.test.ts#anExpressionReadsEveryVariableAndParameterItsDescriptionHoldsOutsideTheQueriesItImportsABindMapsAmongThemAndARewriteReplacesEachOfThem:-:1.0.1.1.f.1.0.1.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0"
				),
				reason:
					"add(r.not(q.bind({ b: a }))), the variable a read only by the negated import's bind map: mapLeaves walked an absent's bindings and kept its source whole, so varsOf read no variable and mapLeaves renamed none, where boundIn and leavesOf walked the bind map (falsified at origin/main 314a9a40, steered case 40)",
				since: "2026-11-18"
			}
		],
		kills: [
			{
				file: "packages/engine/src/ir/desc.ts",
				original: "mapExpr(e, { leaf: (x) => x, term: f, source: (s) => mapBindTerms(s, f) })",
				replacement: "mapExpr(e, { leaf: (x) => x, term: f, source: (s) => s })",
				why: "A map of an expression's children keeps an absent's source whole, its bind map unmapped, as mapLeaves did: varsOf misses a variable only a bind map reads, and the leaves property fails."
			}
		]
	})

/**
 * Each node's children are the terms its description holds in its own scope, in the order it states them, an
 * imported query's aside, and a map of its children replaces each of them and nothing else.
 *
 * Budget: 300 runs and 1000 steered cases, as the leaves property's, over the same space.
 */
export const eachNodesChildrenAreTheTermsItsDescriptionHoldsInItsOwnScopeInItsOrderAndAMapOfThemReplacesEachAndNothingElse =
	property.explore(exprs, {
		needs: {},
		budget: { runs: 300, steered: 1000 },
		situations: Arr.filter(situations, (s) => s !== "a parameter only a bind map reads"),
		check: (_, c: Case<Feature>) => (e) =>
			Effect.sync(() => {
				noted(e, c)
				const wrap = (t: InferredExpr): InferredExpr => ({ kind: "not", arg: t })
				const unwrap = (t: InferredExpr): InferredExpr => (t.kind === "not" ? t.arg : t)
				const visit = (x: InferredExpr): void => {
					const children: ReadonlyArray<unknown> = Arr.map(exprChildren(x), (child) => child.term)
					assert.deepEqual(children, directTerms(x), `the children of a ${x.kind}`)
					const wrapped = mapExprChildren(x, wrap)
					assert.deepEqual(
						directTerms(wrapped),
						Arr.map(exprChildren(x), (child) => wrap(child.term)),
						`a map of the children of a ${x.kind} replaces each`
					)
					assert.deepEqual(
						mapExprChildren(wrapped, unwrap),
						x,
						`a map of the children of a ${x.kind} replaces nothing else`
					)
					for (const child of exprChildren(x)) {
						visit(child.term)
					}
				}
				visit(e)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the description's own values walked as data: every expression a node's own members reach through no other"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/desc.ts",
				original:
					'\t\t\t\t...bindTerms(e.source).map(([param, term]) => ({ term, at: ["bind", param] })),\n',
				replacement: "",
				why: "An absent's children leave out the terms its source's bind map binds, so a walk over them misses a variable or a negation only a bind map holds; the children property fails."
			},
			{
				file: "packages/engine/src/ir/desc.ts",
				original: "\t\t\treturn { ...e, arg: term(e.arg), low: term(e.low), high: term(e.high) }",
				replacement: "\t\t\treturn { ...e, arg: term(e.arg), low: term(e.low), high: e.high }",
				why: "A map of a between's children keeps its upper bound, a child forgotten; the children property fails."
			}
		]
	})
