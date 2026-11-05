import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { ExprId, NodeId } from "#compiler/core/ids.ts"
import { builtExpr, type ScalarExpr } from "#compiler/ir/expr.ts"
import { lexicographicOrder } from "#compiler/lower/shapes/catalog/lexicographic.ts"
import { connectiveOps, definedIdOf, overloadOf } from "#compiler/scalar/compute/registry.ts"
import { plainType } from "#compiler/scalar/compute/types.ts"
import { assert, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/**
 * The lexicographic recognizer (lower/shapes/catalog/lexicographic.ts), whose decision diagram replaced an enumeration
 * of every sign vector over at most six pairs, against that enumeration as the oracle: on every generated predicate
 * over at most six pairs, any Boolean arrangement of native comparisons between paired fields, the lexicographic
 * spellings and their perturbations among them, the recognizer finds exactly the order, directions and inclusiveness
 * the enumeration finds, or, with it, none. Past six pairs, where the enumeration refused, the nested spelling of any
 * order is still recognized as itself. And a predicate nested a hundred thousand connectives deep, which a recursion
 * would overflow the call stack on, is recognized or refused exactly as the shallow predicate it is equivalent to.
 */

type Cmp = "eq" | "ne" | "lt" | "le" | "gt" | "ge"
const cmps: readonly [Cmp, ...ReadonlyArray<Cmp>] = ["eq", "ne", "lt", "le", "gt", "ge"]

/** A predicate over pairs: b_pair <cmp> a_pair (or its operands swapped), and the connectives over such atoms. */
type Tree =
	| { readonly kind: "atom"; readonly pair: number; readonly cmp: Cmp; readonly swapped: boolean }
	| { readonly kind: "and" | "or"; readonly args: Arr.NonEmptyReadonlyArray<Tree> }
	| { readonly kind: "not"; readonly arg: Tree }

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
		readonly dir: "asc" | "desc"
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

const int4 = plainType("int4")
const bool = plainType("bool")
const region = NodeId("region")

const column = (name: string, at: string): ScalarExpr =>
	builtExpr(
		{ kind: "column", column: { node: region, name }, args: [], type: int4, nonNull: "storage" },
		ExprId(`${at}.${name}`)
	)

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
 * The IR of a tree at `at`, its expressions labelled by their place in it: each atom a native int4 comparison of the
 * pair's columns, each connective its boolean operator.
 */
const exprOf = (t: Tree, at: string): ScalarExpr => {
	switch (t.kind) {
		case "atom": {
			const native = defined(overloadOf(t.cmp, ["int4", "int4"]), `the int4 ${t.cmp}`)
			const b = column(`b${t.pair}`, at)
			const a = column(`a${t.pair}`, at)
			return builtExpr(
				{
					kind: "op",
					op: defined(definedIdOf(native), `${t.cmp} defined on int4`),
					args: t.swapped ? [a, b] : [b, a],
					type: bool,
					nonNull: "strict",
					volatility: "immutable"
				},
				ExprId(at)
			)
		}
		case "and":
		case "or":
			return connectiveExpr(
				t.kind,
				Arr.map(t.args, (a, i) => exprOf(a, `${at}.${i}`)),
				at
			)
		case "not":
			return connectiveExpr("not", [exprOf(t.arg, `${at}.0`)], at)
	}
}

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
	pairs: ReadonlyArray<{ readonly pair: number; readonly dir: "asc" | "desc" }>,
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
		const order = Arr.filter(Arr.range(0, pairs - 1), () => source.draw(boolean))
		return nested(
			Arr.map(order, (pair) => ({ pair, dir: source.draw(element(["asc", "desc"] as const)) })),
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

const caseGen: Gen<Tree> = (source) => {
	const pairs = source.draw(int(1, 6))
	return source.draw(oneOf([treeGen(pairs, 3), spellingGen(pairs), perturbedGen(pairs)]))
}

/** A shallow predicate, and the pattern of wrappers that deepens it, one to three. */
const deepGen: Gen<{
	readonly tree: Tree
	readonly pattern: Arr.NonEmptyReadonlyArray<Wrapper>
}> = (source) => ({
	tree: source.draw(caseGen),
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

describe("the lexicographic recognizer", () => {
	it.effect(
		"decides every arrangement of up to six pairs exactly as the enumeration of every sign vector does",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/lower/catalog/lexicographic-oracle",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<LexFeature>(
							["recognized", "not lexicographic", "inclusive", "strict", "several pairs ordered"],
							{ cases: 600, sense: notesOnly }
						),
						kept: [],
						runs: 600,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(t, c) =>
						Effect.sync(() => {
							const expected = enumerated(t)
							const got = lexicographicOrder(exprOf(t, "p"), classify)
							assert.deepEqual(got, expected)
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
						suite: "unit/lower/catalog/lexicographic-wide",
						draw: drawn((source) => {
							const pairs = source.draw(int(7, 10))
							return {
								order: Arr.map(Arr.range(0, pairs - 1), (pair) => ({
									pair,
									dir: source.draw(element(["asc", "desc"] as const))
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
