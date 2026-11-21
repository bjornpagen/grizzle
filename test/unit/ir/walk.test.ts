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
import { Array as Arr, Effect, Record as Rec, String as Str } from "effect"
import { boundIn, mapLeaves, varsOf } from "#compiler/analysis/theory/leaves.ts"
import { leavesOf } from "#compiler/check/scan.ts"
import {
	callsOf,
	exprChildren,
	type InferredExpr,
	type InferredQuery,
	mapExprChildren,
	mapQueryParams,
	type ParamSpelling,
	queryParamNames
} from "#compiler/ir/desc.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import {
	bindOnly,
	directTerms,
	exprKinds,
	exprs,
	type Feature,
	kindsIn,
	leafNames,
	ownParamNames,
	ownSites,
	walkedQueries
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

/** A query's parameter names as mapQueryParams spells them, in its order: the description rebuilt, its imports too. */
const spelledNames = (q: InferredQuery): ReadonlyArray<string> => {
	const names = new Set<string>()
	const asIs: ParamSpelling<{ readonly name: string }> = {
		param: (name) => ({ name }),
		imported: () => asIs
	}
	mapQueryParams(
		q,
		{
			param: (name) => {
				names.add(name)
				return { name }
			},
			imported: () => asIs
		},
		new Map()
	)
	return [...names]
}

/** What a query's case reached: each kind of its last stage, and each place only a parameter of one kind stands. */
type QueryFeature =
	| `a ${InferredQuery["stage"]["kind"]} stage`
	| "a take bound to a parameter"
	| "a relation parameter as a source"
	| "an imported query read"

const queryStages: ReadonlyArray<InferredQuery["stage"]["kind"]> = [
	"rules",
	"recursive",
	"union",
	"attach",
	"named",
	"approx",
	"take"
]

/**
 * A query description's parameters, read without rebuilding it (ir/desc.ts queryParamNames), are the ones
 * mapQueryParams spells, in its order, and every one its own namespace holds; and the read enters no query it imports,
 * whose parameters are its own.
 *
 * Oracle: mapQueryParams's spelling, the walk that rebuilds the description, for the names and their order; and the
 * description's own values walked as data, for the set.
 *
 * Budget: 300 runs and 1000 steered cases, as the expression walks', over queries of every stage holding their
 * expressions.
 */
export const aQuerysParametersReadWithoutRebuildingItAreTheOnesItsRebuildSpellsInItsOrderAndTheReadEntersNoImportedQuery =
	property.explore(walkedQueries, {
		needs: {},
		budget: { runs: 300, steered: 1000 },
		situations: [
			...Arr.map(queryStages, (kind) => `a ${kind} stage` as const),
			"a take bound to a parameter",
			"a relation parameter as a source",
			"an imported query read"
		],
		check: (_, c: Case<QueryFeature>) => (walked) =>
			Effect.sync(() => {
				walked.reads.count = 0
				const names = queryParamNames(walked.query)
				assert.equal(walked.reads.count, 0, "queryParamNames enters no imported query")
				const read: ReadonlyArray<string> = [...names]
				assert.deepEqual(
					read,
					spelledNames(walked.query),
					"queryParamNames reads the parameters mapQueryParams spells, in its order"
				)
				if (walked.reads.count > 0) {
					c.note("an imported query read")
				}
				const stage = walked.query.stage
				c.note(`a ${stage.kind} stage`)
				if (stage.kind === "take" && stage.take.kind === "param") {
					c.note("a take bound to a parameter")
				}
				if (Arr.some(ownSites(walked.query), (site) => site.kind === "paramOf")) {
					c.note("a relation parameter as a source")
				}
				assert.deepEqual(
					sorted(names),
					sorted(ownParamNames(walked.query)),
					"queryParamNames reads every parameter of the query's own namespace"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "mapQueryParams's spelling, which rebuilds the description, and the description's own values walked as data"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/desc.ts",
				original: "\tnew ParamReads<T>((name) => names.add(name)).query(q)\n",
				replacement:
					"\tmapQueryParams(q, { param: (name) => ({ name: names.add(name) && name }), imported: () => spelledAsIs }, new Map())\n",
				why: "The names are read by the rebuilding walk, as before: it reads every imported query's stage to rebuild it, so the tripwire counts reads and the property fails."
			},
			{
				file: "packages/engine/src/ir/desc.ts",
				original: 'if (s.take.kind === "param") {\n\t\t\t\t\tthis.#read(s.take.name)\n',
				replacement: 'if (s.take.kind === "param") {\n',
				why: "A take bound to a parameter is read as none: its name is missing against mapQueryParams's and the oracle's."
			},
			{
				file: "packages/engine/src/ir/desc.ts",
				original: 'if (b.kind === "relationParam") {\n\t\t\t\tthis.#read(b.name)\n',
				replacement: 'if (b.kind === "relationParam") {\n',
				why: "A relation parameter a bind map binds is read as none: its name is missing against mapQueryParams's and the oracle's."
			}
		]
	})

/**
 * The references a walk reading each record and list of a value once follows: the value's own, and each member of every
 * distinct record and list the value reaches.
 */
const referencesOnce = (value: unknown): number => {
	const seen = new Set<object>()
	let references = 1
	const reach = (v: unknown): void => {
		if (typeof v !== "object" || v === null || seen.has(v)) {
			return
		}
		seen.add(v)
		const members: ReadonlyArray<unknown> = Arr.isArray(v) ? v : Rec.values(v)
		references += members.length
		for (const member of members) {
			reach(member)
		}
	}
	reach(value)
	return references
}

/** The functions a value names at a node of kind call or callField, walked as a tree, every reference read anew. */
const calledInTree = (value: unknown): ReadonlySet<unknown> => {
	const out = new Set<unknown>()
	const reach = (v: unknown): void => {
		if (typeof v !== "object" || v === null) {
			return
		}
		if (!Arr.isArray(v)) {
			const kind: unknown = Reflect.get(v, "kind")
			const called: unknown = Reflect.get(v, "function")
			if ((kind === "call" || kind === "callField") && typeof called === "string") {
				out.add(called)
			}
		}
		for (const member of Arr.isArray(v) ? v : Rec.values(v)) {
			reach(member)
		}
	}
	reach(value)
	return out
}

/**
 * The declared functions a Description calls (ir/desc.ts callsOf) are every function a call of it names, and the walk
 * reads each record and list once however many times the Description shares it: an expression shared by both operands
 * of each of twelve nested conjunctions is read once, where a walk at every reference read it 4,096 times.
 *
 * Oracle: the functions a tree walk of the expression names (a second implementation), and the references of the distinct
 * parts the shared Description reaches, against V8's count of the walk's calls.
 *
 * Budget: 300 runs and 300 steered cases, the expression walks', over their expressions.
 */
export const theFunctionsADescriptionCallsAreReadOnceForEachPartItSharesAndAreEveryOneItsCallsName =
	property.explore(exprs, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: ["a call named"] satisfies ReadonlyArray<Reached<"a call named">>,
		check: (_, c: Case<"a call named">) => (e) =>
			Effect.gen(function* () {
				let shared: unknown = e
				for (let depth = 0; depth < 12; depth++) {
					shared = { kind: "and", args: [shared, shared] }
				}
				const [found, counts] = yield* callCounts(
					Effect.sync(() => callsOf(shared)),
					{ walk: { file: "packages/engine/src/ir/desc.ts", name: "walk" } }
				)
				const expected = calledInTree(e)
				assert.deepEqual(sorted(found), sorted(expected), "every function a call names")
				if (expected.size > 0) {
					c.note("a call named")
				}
				assert.equal(
					counts.walk,
					referencesOnce(shared),
					"the walk follows each reference of each distinct part once"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "a tree walk of the expression's functions, and the distinct parts the shared Description reaches"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/desc.ts",
				original: '\t\tif (typeof node !== "object" || node === null || read.has(node)) {\n',
				replacement: '\t\tif (typeof node !== "object" || node === null) {\n',
				why: "The walk reads a shared part at every reference, as before: the twelve nested conjunctions' expression is read 4,096 times, and the reads outnumber the references of the distinct parts."
			}
		]
	})
