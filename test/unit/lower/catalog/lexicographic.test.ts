/**
 * The lexicographic recognizer (lower/shapes/catalog/lexicographic.ts), whose decision diagram replaced an enumeration
 * of every sign vector over at most six pairs, against that enumeration as the oracle: on every generated predicate
 * over at most six pairs, any Boolean arrangement of native comparisons between paired fields, the lexicographic
 * spellings and their perturbations among them, the recognizer finds exactly the order, directions and inclusiveness
 * the enumeration finds, or, with it, none. Past six pairs, where the enumeration refused, the nested spelling of any
 * order is still recognized as itself. A predicate any of whose parts is a native test of a pair that compares no order,
 * a prefix test of its text fields, is no lexicographic order, whatever the rest of it is. And a predicate nested a
 * hundred thousand connectives deep, which a recursion would overflow the call stack on, is recognized or refused
 * exactly as the shallow predicate it is equivalent to.
 *
 * Oracle: the enumeration of every sign vector the recognizer replaced, a second implementation, over up to six pairs;
 * past six, the order the nested spelling was built from; and the deep predicate's shallow equivalent, a metamorphic
 * relation.
 *
 * Features: recognized or not, inclusive or strict, several pairs ordered, a prefix test among the parts.
 *
 * Plants, each failing its search: the direction of the second pair parsed read backwards (lexicographic-direction,
 * failing the oracle and the wide searches); the parser recursing into connectives on the call stack
 * (lexicographic-recursion, failing the deep search).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, map, oneOf, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { ExprId, NodeId } from "#compiler/core/ids.ts"
import { type Direction, directions } from "#compiler/core/order.ts"
import { builtExpr, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { lexicographicOrder } from "#compiler/lower/shapes/catalog/lexicographic.ts"
import { connectiveOps, definedIdOf, overloadOf } from "#compiler/scalar/compute/registry.ts"
import { wildcardText } from "#compiler/scalar/compute/types.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { assert, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { upTo } from "#test/support/up-to.ts"

type Cmp = "eq" | "ne" | "lt" | "le" | "gt" | "ge"
const cmps: readonly [Cmp, ...ReadonlyArray<Cmp>] = ["eq", "ne", "lt", "le", "gt", "ge"]

/** A comparison of one pair: b_pair <cmp> a_pair, or its operands swapped. */
interface Atom {
	readonly kind: "atom"
	readonly pair: number
	readonly cmp: Cmp
	readonly swapped: boolean
}

/** A native test of one pair that compares no order: starts_with(b_pair, a_pair), or its operands swapped. */
interface Prefix {
	readonly kind: "prefix"
	readonly pair: number
	readonly swapped: boolean
}

/** A predicate over pairs: its leaves, comparisons unless stated, and the connectives over them. */
type Tree<L extends Atom | Prefix = Atom> =
	| L
	| { readonly kind: "and" | "or"; readonly args: Arr.NonEmptyReadonlyArray<Tree<L>> }
	| { readonly kind: "not"; readonly arg: Tree<L> }

/**
 * A case: a predicate of comparisons, which the enumeration decides, or one with a prefix test among its parts, which
 * is no lexicographic order; the fields of the first are int4, of the second text.
 */
type Case =
	| { readonly kind: "comparisons"; readonly tree: Tree }
	| { readonly kind: "prefixed"; readonly tree: Tree<Atom | Prefix> }

const flip: Readonly<Record<Cmp, Cmp>> = {
	eq: "eq",
	ne: "ne",
	lt: "gt",
	le: "ge",
	gt: "lt",
	ge: "le"
}

const holds = (cmp: Cmp, sign: number): boolean =>
	cmp === "eq"
		? sign === 0
		: cmp === "ne"
			? sign !== 0
			: cmp === "lt"
				? sign < 0
				: cmp === "le"
					? sign <= 0
					: cmp === "gt"
						? sign > 0
						: sign >= 0

/** The tree's truth under the sign of b - a of each pair. */
const truth = (t: Tree, signs: ReadonlyMap<number, number>): boolean => {
	switch (t.kind) {
		case "atom":
			return holds(t.swapped ? flip[t.cmp] : t.cmp, signs.get(t.pair) ?? 0)
		case "and":
			return Arr.every(t.args, (a) => truth(a, signs))
		case "or":
			return Arr.some(t.args, (a) => truth(a, signs))
		case "not":
			return !truth(t.arg, signs)
	}
}

/** The pairs a tree compares, in first-use order. */
const pairsOf = (t: Tree): ReadonlyArray<number> => {
	const out: Array<number> = []
	const visit = (x: Tree): void => {
		switch (x.kind) {
			case "atom":
				if (!out.includes(x.pair)) {
					out.push(x.pair)
				}
				return
			case "and":
			case "or":
				for (const a of x.args) {
					visit(a)
				}
				return
			case "not":
				visit(x.arg)
		}
	}
	visit(t)
	return out
}

interface Order {
	readonly order: ReadonlyArray<{
		readonly b: string
		readonly a: string
		readonly dir: Direction
	}>
	readonly inclusive: boolean
}

/**
 * The enumeration the recognizer replaced, over the tree's truth: the one value the tree takes over every sign vector
 * of the free pairs, the rest fixed, or none; and the recursion that finds the pair deciding the tree whenever its
 * fields differ, ties it, and goes on. It evaluates 3^pairs vectors per question.
 */
const enumerated = (t: Tree): Order | undefined => {
	const pairs = pairsOf(t)
	const constantOver = (free: ReadonlyArray<number>, fixed: ReadonlyMap<number, number>) => {
		const values = new Set<boolean>()
		for (let n = 0; n < 3 ** free.length; n++) {
			const signs = new Map(fixed)
			let m = n
			for (const p of free) {
				signs.set(p, (m % 3) - 1)
				m = Math.floor(m / 3)
			}
			values.add(truth(t, signs))
		}
		const [only] = values
		return values.size === 1 ? only : undefined
	}
	const order: Array<Order["order"][number]> = []
	const fixed = new Map<number, number>()
	let remaining = pairs
	for (;;) {
		const constant = constantOver(remaining, fixed)
		if (constant !== undefined) {
			return { order, inclusive: constant }
		}
		const chosen = Arr.flatMap(remaining, (c) => {
			const others = Arr.filter(remaining, (p) => p !== c)
			const below = constantOver(others, new Map(fixed).set(c, -1))
			const above = constantOver(others, new Map(fixed).set(c, 1))
			return below === undefined || above === undefined || below === above
				? []
				: [{ c, dir: below ? ("asc" as const) : ("desc" as const) }]
		})[0]
		if (chosen === undefined) {
			return undefined
		}
		order.push({ b: `b${chosen.c}`, a: `a${chosen.c}`, dir: chosen.dir })
		fixed.set(chosen.c, 0)
		remaining = Arr.filter(remaining, (p) => p !== chosen.c)
	}
}

type FieldType = "int4" | "text"
const fieldTypes: Readonly<Record<FieldType, ScalarType>> = {
	int4: plainType("int4"),
	text: wildcardText
}
const bool = plainType("bool")
const region = NodeId("region")

const column = (name: string, at: string, type: FieldType): ScalarExpr =>
	builtExpr(
		{
			kind: "column",
			column: { node: region, name },
			args: [],
			type: fieldTypes[type],
			nonNull: "storage"
		},
		ExprId(`${at}.${name}`)
	)

/** The native operator `fn` over the pair's two fields of `type`, in the leaf's order. */
const pairExpr = (
	fn: Cmp | "startsWith",
	leaf: Atom | Prefix,
	at: string,
	type: FieldType
): ScalarExpr => {
	const native = defined(overloadOf(fn, [type, type]), `the ${type} ${fn}`)
	const b = column(`b${leaf.pair}`, at, type)
	const a = column(`a${leaf.pair}`, at, type)
	return builtExpr(
		{
			kind: "op",
			op: defined(definedIdOf(native), `${fn} defined on ${type}`),
			args: leaf.swapped ? [a, b] : [b, a],
			type: bool,
			nonNull: "strict",
			volatility: "immutable"
		},
		ExprId(at)
	)
}

/** The connective `kind` over `args`, labelled `at`. */
const connectiveExpr = (
	kind: "and" | "or" | "not",
	args: ReadonlyArray<ScalarExpr>,
	at: string
): ScalarExpr =>
	builtExpr(
		{
			kind: "op",
			op: connectiveOps[kind],
			args,
			type: bool,
			nonNull: "strict",
			volatility: "immutable"
		},
		ExprId(at)
	)

/**
 * The IR of a tree at `at` over fields of `type`, its expressions labelled by their place in it: each atom a native
 * comparison of the pair's columns, each prefix test their native starts_with, each connective its boolean operator.
 */
const treeExpr = (t: Tree<Atom | Prefix>, at: string, type: FieldType): ScalarExpr => {
	switch (t.kind) {
		case "atom":
			return pairExpr(t.cmp, t, at, type)
		case "prefix":
			return pairExpr("startsWith", t, at, type)
		case "and":
		case "or":
			return connectiveExpr(
				t.kind,
				Arr.map(t.args, (a, i) => treeExpr(a, `${at}.${i}`, type)),
				at
			)
		case "not":
			return connectiveExpr("not", [treeExpr(t.arg, `${at}.0`, type)], at)
	}
}

/** The IR of a comparisons tree, over int4 fields. */
const exprOf = (t: Tree, at: string): ScalarExpr => treeExpr(t, at, "int4")

/** The IR of a case at `at`. */
const caseExpr = (c: Case, at: string): ScalarExpr =>
	c.kind === "comparisons" ? exprOf(c.tree, at) : treeExpr(c.tree, at, "text")

/** What the recognizer must find of a case: the enumeration's order of a comparisons tree, and none of a prefixed one. */
const expectedOf = (c: Case): Order | undefined =>
	c.kind === "comparisons" ? enumerated(c.tree) : undefined

/**
 * How one level of a deepened predicate wraps the level below, each the level below's own function: its conjunction
 * or its disjunction with the shallow predicate, or the negation of its negation.
 */
type Wrapper = "conjunction" | "disjunction" | "double negation"
const wrappers: Arr.NonEmptyReadonlyArray<Wrapper> = [
	"conjunction",
	"disjunction",
	"double negation"
]

/** The levels of a deepened predicate: a nesting a recursion would overflow the small stack at. */
const deepLevels = 100_000

/**
 * The IR of `t` under deepLevels levels, each wrapping the level below by the next wrapper of `pattern` in turn, built
 * level by level, so no recursion builds it. Every conjunction and disjunction shares the shallow predicate's one IR,
 * so the deepened predicate holds a node or two per level beside it, and computes t's own function.
 */
const deepened = (t: Tree, pattern: Arr.NonEmptyReadonlyArray<Wrapper>): ScalarExpr => {
	const shallow = exprOf(t, "p")
	let e = shallow
	for (let level = 0; level < deepLevels; level++) {
		const at = `w${level}`
		const wrapper = defined(pattern[level % pattern.length], "the pattern's wrapper of a level")
		e =
			wrapper === "double negation"
				? connectiveExpr("not", [connectiveExpr("not", [e], `${at}.0`)], at)
				: connectiveExpr(wrapper === "conjunction" ? "and" : "or", [shallow, e], at)
	}
	return e
}

const classify = (ref: { readonly name: string }) =>
	Str.startsWith("b")(ref.name)
		? { side: "b" as const, id: ref.name }
		: Str.startsWith("a")(ref.name)
			? { side: "a" as const, id: ref.name }
			: undefined

/** The nested spelling of a lexicographic order over `pairs`, each with its direction, strict or inclusive. */
const nested = (
	pairs: ReadonlyArray<{ readonly pair: number; readonly dir: Direction }>,
	inclusive: boolean
): Tree => {
	const [first, ...rest] = pairs
	if (first === undefined) {
		return inclusive
			? { kind: "atom", pair: 0, cmp: "eq", swapped: false }
			: { kind: "atom", pair: 0, cmp: "ne", swapped: false }
	}
	const strict: Tree = {
		kind: "atom",
		pair: first.pair,
		cmp: first.dir === "asc" ? "lt" : "gt",
		swapped: false
	}
	if (rest.length === 0) {
		return inclusive
			? { kind: "atom", pair: first.pair, cmp: first.dir === "asc" ? "le" : "ge", swapped: false }
			: strict
	}
	return {
		kind: "or",
		args: [
			strict,
			{
				kind: "and",
				args: [
					{ kind: "atom", pair: first.pair, cmp: "eq", swapped: false },
					nested(rest, inclusive)
				]
			}
		]
	}
}

const atomGen =
	(pairs: number): Gen<Tree> =>
	(source) => ({
		kind: "atom",
		pair: source.draw(int(0, pairs - 1)),
		cmp: source.draw(element(cmps)),
		swapped: source.draw(boolean)
	})

/** Any arrangement of atoms over `pairs` pairs, up to `depth` connectives deep. */
const treeGen =
	(pairs: number, depth: number): Gen<Tree> =>
	(source) => {
		if (depth === 0 || source.draw(int(0, 2)) === 0) {
			return source.draw(atomGen(pairs))
		}
		const kind = source.draw(element(["and", "or", "not"] as const))
		if (kind === "not") {
			return { kind, arg: source.draw(treeGen(pairs, depth - 1)) }
		}
		const [first, ...rest] = source.draw(array(treeGen(pairs, depth - 1), { min: 1, max: 3 }))
		return first === undefined ? source.draw(atomGen(pairs)) : { kind, args: [first, ...rest] }
	}

/** A lexicographic spelling over some of `pairs` pairs, as the nested form, its order and directions drawn. */
const spellingGen =
	(pairs: number): Gen<Tree> =>
	(source) => {
		const order = Arr.filter(
			upTo(pairs, (i) => i),
			() => source.draw(boolean)
		)
		return nested(
			Arr.map(order, (pair) => ({ pair, dir: source.draw(element(directions)) })),
			source.draw(boolean)
		)
	}

/** A spelling perturbed at one atom: its comparison redrawn, which may or may not leave it lexicographic. */
const perturbedGen =
	(pairs: number): Gen<Tree> =>
	(source) => {
		const t = source.draw(spellingGen(pairs))
		const cmp = source.draw(element(cmps))
		const perturb = (x: Tree, first: { done: boolean }): Tree => {
			switch (x.kind) {
				case "atom":
					if (first.done) {
						return x
					}
					first.done = true
					return { ...x, cmp }
				case "and":
				case "or":
					return {
						kind: x.kind,
						args: [perturb(x.args[0], first), ...Arr.map(x.args.slice(1), (a) => perturb(a, first))]
					}
				case "not":
					return { kind: "not", arg: perturb(x.arg, first) }
			}
		}
		return perturb(t, { done: false })
	}

const comparisonsGen: Gen<Tree> = (source) => {
	const pairs = source.draw(int(1, 6))
	return source.draw(oneOf([treeGen(pairs, 3), spellingGen(pairs), perturbedGen(pairs)]))
}

/** How many atoms a tree holds. */
const atomCount = (t: Tree): number => {
	switch (t.kind) {
		case "atom":
			return 1
		case "and":
		case "or":
			return Arr.reduce(t.args, 0, (n, a) => n + atomCount(a))
		case "not":
			return atomCount(t.arg)
	}
}

/** The tree with its atom at `place` in reading order a prefix test of the same pair, its operands in the same order. */
const withPrefixAt = (t: Tree, place: number): Tree<Atom | Prefix> => {
	const read = { atoms: 0 }
	const visit = (x: Tree): Tree<Atom | Prefix> => {
		switch (x.kind) {
			case "atom": {
				const here = read.atoms
				read.atoms = here + 1
				return here === place ? { kind: "prefix", pair: x.pair, swapped: x.swapped } : x
			}
			case "and":
			case "or":
				return { kind: x.kind, args: Arr.map(x.args, visit) }
			case "not":
				return { kind: "not", arg: visit(x.arg) }
		}
	}
	return visit(t)
}

/** A comparisons tree, or, in one case in five, one with a drawn atom a prefix test. */
const caseGen: Gen<Case> = weighted<Case>([
	[4, map(comparisonsGen, (tree): Case => ({ kind: "comparisons", tree }))],
	[
		1,
		(source) => {
			const tree = source.draw(comparisonsGen)
			return {
				kind: "prefixed",
				tree: withPrefixAt(tree, source.draw(int(0, atomCount(tree) - 1)))
			}
		}
	]
])

/** A shallow predicate, and the pattern of wrappers that deepens it, one to three. */
const deepGen: Gen<{
	readonly tree: Tree
	readonly pattern: Arr.NonEmptyReadonlyArray<Wrapper>
}> = (source) => ({
	tree: source.draw(comparisonsGen),
	pattern: [
		source.draw(element(wrappers)),
		...source.draw(array(element(wrappers), { min: 0, max: 2 }))
	]
})

type LexFeature =
	| "recognized"
	| "not lexicographic"
	| "inclusive"
	| "strict"
	| "several pairs ordered"
	| "a prefix test among the parts"

describe("the lexicographic recognizer", () => {
	it.effect(
		"decides every arrangement of up to six pairs exactly as the enumeration of every sign vector does",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "the enumeration of every sign vector of the pairs a predicate compares"
						},
						suite: "unit/lower/catalog/lexicographic-oracle",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<LexFeature>(
							[
								"recognized",
								"not lexicographic",
								"inclusive",
								"strict",
								"several pairs ordered",
								"a prefix test among the parts"
							],
							{ cases: 600, sense: notesOnly }
						),
						kept: [],
						runs: 600,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(k, c) =>
						Effect.sync(() => {
							const expected = expectedOf(k)
							const got = lexicographicOrder(caseExpr(k, "p"), classify)
							assert.deepEqual(got, expected)
							if (k.kind === "prefixed") {
								c.note("a prefix test among the parts")
							}
							if (expected === undefined) {
								c.note("not lexicographic")
								return
							}
							c.note("recognized")
							c.note(expected.inclusive ? "inclusive" : "strict")
							if (expected.order.length > 1) {
								c.note("several pairs ordered")
							}
						})
				)
			)
	)

	it.effect(
		"recognizes the nested spelling of any order of seven to ten pairs, past the enumeration's six",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the order and inclusiveness the nested spelling was built from"
						},
						suite: "unit/lower/catalog/lexicographic-wide",
						draw: drawn((source) => {
							const pairs = source.draw(int(7, 10))
							return {
								order: upTo(pairs, (pair) => ({
									pair,
									dir: source.draw(element(directions))
								})),
								inclusive: source.draw(boolean)
							}
						}),
						literal: Formatter.format,
						coverage: required<"inclusive" | "strict">(["inclusive", "strict"], {
							cases: 40,
							sense: notesOnly
						}),
						kept: [],
						runs: 40,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
						Effect.sync(() => {
							c.note(s.inclusive ? "inclusive" : "strict")
							assert.deepEqual(
								lexicographicOrder(exprOf(nested(s.order, s.inclusive), "p"), classify),
								{
									order: Arr.map(s.order, (o) => ({
										b: `b${o.pair}`,
										a: `a${o.pair}`,
										dir: o.dir
									})),
									inclusive: s.inclusive
								}
							)
						})
				)
			)
	)

	it.effect(
		"recognizes or refuses a predicate nested a hundred thousand connectives deep exactly as its shallow equivalent",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "universal",
							name: "a predicate deepened by wrappers that keep its function decides as its shallow self"
						},
						suite: "unit/lower/catalog/lexicographic-deep",
						draw: drawn(deepGen),
						literal: Formatter.format,
						coverage: required<"recognized" | "not lexicographic">(
							["recognized", "not lexicographic"],
							{ cases: 24, sense: notesOnly }
						),
						kept: [],
						runs: 24,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
						Effect.sync(() => {
							const shallow = lexicographicOrder(exprOf(s.tree, "p"), classify)
							c.note(shallow === undefined ? "not lexicographic" : "recognized")
							assert.deepEqual(lexicographicOrder(deepened(s.tree, s.pattern), classify), shallow)
						})
				)
			)
	)
})
