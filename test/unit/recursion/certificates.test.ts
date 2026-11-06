import { describe, it } from "@effect/vitest"
import { explore, type Kept, sketched } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	pipe,
	Record as Rec,
	String as Str
} from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { indices, maxOf } from "#compiler/core/array.ts"
import type { RecursionRefusal } from "#compiler/core/causes.ts"
import { MoneyText } from "#compiler/ir/carriers.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { DecimalText } from "#compiler/ir/decimal.ts"
import type { FieldDesc, PgScalarName } from "#compiler/ir/desc.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { type LogicalQuery, paramColumns } from "#compiler/ir/products.ts"
import type { Heading, NodeOf, TerminationCert } from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import {
	decodedQuery,
	type AuthoredExprDesc as ExprDesc,
	type QueryDesc,
	type RuleDesc
} from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import { canonicalFacts, type GenFacts } from "#test/support/oracle/gen/facts.ts"
import type { GenParam } from "#test/support/oracle/gen/query.ts"
import type { GenSchema } from "#test/support/oracle/gen/schema.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import {
	maxIterations,
	noBindings,
	Reference,
	unobserved
} from "#test/support/oracle/reference/evaluate.ts"
import { valueKey } from "#test/support/oracle/reference/values.ts"
import { pickFrom, pickIndex } from "#test/support/pick.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import {
	cast,
	compute,
	eq,
	lit,
	match,
	narrowed,
	param,
	plainVar,
	ref,
	relationSource,
	rule,
	typedLit,
	varRef,
	vars
} from "#test/unit/check/dsl.ts"
import { Graph, theRecursive } from "#test/unit/recursion/fixtures.ts"

/**
 * Generated recursions against the termination proof rules: for every recursive definition the generator draws, the
 * checker's verdict is the one a reference model of the rules gives, and so is the certificate's family and state
 * estimate.
 *
 * A definition walks Graph's edges from a parameter root, with a state of its node, a counter-like column h and a tag
 * column t of one integer carrier, and a mark m of text. Its base arms seed h, t and m with literals; its recursive arms
 * deliver for h a literal, a copy of h or of t, a step h + k, k + h or h - k under zero to two guards on h (a comparison
 * either way round with a literal or a parameter, a range, or a disequality), a product or a sum with the edge's cost,
 * or the cost itself; for t a literal, a copy, the cost or the cost plus a literal, or a product; for m a literal or a
 * copy. A recursive arm may also pin h to a vertex's rank, so h is data there. A head literal is typed, untyped (the
 * state column types it) or a narrower integer literal cast to the carrier, which are one value to the rules.
 *
 * The reference model, written from the rules as termination.ts states them:
 *
 * - a literal is one value; data (the edge's columns, a pinned h, a computed term over data only) counts once; a copy
 *   of the column's own state adds nothing; a copy of another column widens to that column's values;
 * - h + k, k + h and h - k with k a nonzero integer literal are a counter when a guard bounds h on the side it moves
 *   towards: the last value the guards admit is the tightest bound, and the counter produces that value plus its
 *   step, which must stay inside the carrier (a parameter bound is the carrier's extreme), or the recursion is
 *   refused for carrier overflow;
 * - any other term computed from a column's own value is unbounded computed state, refused;
 * - a counter counts every integer from its least to its greatest value: the seeds' range when every other value is
 *   a known literal, the carrier's range otherwise, widened to what the counter produces;
 * - the estimate is the product over the columns, recorded and never refused, whatever its size; the family is
 *   finiteCarrier without a counter, boundedState with an increasing one, wellFounded with only decreasing ones;
 * - a counter's step is exact integer arithmetic, narrowed into the carrier: from every value the counter can hold,
 *   least to greatest, each of its steps stays inside the carrier, the step past its last state included, or the
 *   narrowing is unproved, PartialOperation, which admission decides after the rules above. Every other integer
 *   arithmetic the definition computes is narrowed under the guard that it fits, as a program writes it.
 *
 * The model restates the rules, so a rule that is unsound in both, an estimate below the states a recursion really
 * reaches, would pass the comparison. So every admitted definition also runs, by the reference evaluator's fixpoint,
 * over small generated graphs: it must reach its fixpoint, and no vertex may carry more distinct states than the
 * estimate over that graph. The rules count a column's data once, the states per combination of carrier values, and a
 * vertex holds a state for each value the graph's data gives a column there (edges of two costs into it, or the cost
 * beside the cost plus one), so over a graph the model counts a column's data as the distinct values its data forms
 * take on the graph's edges. That comparison bites where a vertex reaches the bound, so the draw holds definitions
 * without data whose estimate a vertex with a self-loop reaches exactly. The fixpoint runs where the reference reaches it within its step limit
 * under the estimate; a definition whose estimate over a graph is past that limit, such as a counter stepping toward a
 * bound near the carrier's extreme, is held to its verdict, family and estimate alone. A guard's literal bound is drawn
 * near the carrier's extremes too, where a counter's next value leaves the carrier before the bound is checked.
 */

type Carrier = "smallint" | "integer" | "bigint"
const ranges: Readonly<Record<Carrier, readonly [bigint, bigint]>> = {
	smallint: [-32768n, 32767n],
	integer: [-2147483648n, 2147483647n],
	bigint: [-9223372036854775808n, 9223372036854775807n]
}

type Spelling = "typed" | "untyped" | "cast"
interface Lit {
	readonly value: number
	readonly spelling: Spelling
}

type Op = "lt" | "le" | "eq" | "ge" | "gt" | "ne"
/** A literal bound near one of the carrier's extremes: the extreme, or one or two inside it. */
interface Edge {
	readonly extreme: "min" | "max"
	readonly inside: 0 | 1 | 2
}
type Bound = number | "param" | Edge
type Guard =
	| { readonly kind: "compare"; readonly op: Op; readonly bound: Bound; readonly flipped: boolean }
	| { readonly kind: "between"; readonly low: number; readonly high: number }

type Step =
	| { readonly kind: "add" | "addLeft" | "sub"; readonly k: Lit }
	| { readonly kind: "copy" | "copyTag" | "mul" | "addCost" | "cost" | "costPlus" }
	| { readonly kind: "literal"; readonly value: Lit }

type Tag =
	| { readonly kind: "literal"; readonly value: Lit }
	| { readonly kind: "copy" | "cost" | "costPlus" | "mul" }

type Mark = { readonly kind: "literal"; readonly value: string } | { readonly kind: "copy" }

interface ArmSpec {
	readonly h: Step
	readonly t: Tag
	readonly m: Mark
	readonly guards: ReadonlyArray<Guard>
	/** The guards as one AND conjunct. */
	readonly nested: boolean
	readonly pinned: boolean
}

interface Spec {
	readonly carrier: Carrier
	readonly seeds: ReadonlyArray<{ readonly h: Lit; readonly t: Lit; readonly m: string }>
	readonly arms: ReadonlyArray<ArmSpec>
}

const litGen =
	(min: number, max: number): Gen<Lit> =>
	(source) => ({
		value: source.draw(int(min, max)),
		spelling: source.draw(element<Spelling>(["typed", "untyped", "cast"]))
	})

const guardGen: Gen<Guard> = weighted([
	[
		5,
		(source) => ({
			kind: source.draw(constant<"compare">("compare")),
			op: source.draw(element<Op>(["lt", "le", "eq", "ge", "gt", "ne"])),
			bound: source.draw(
				weighted<Bound>([
					[5, int(-2, 8)],
					[1, constant<"param">("param")],
					[
						1,
						(source) => ({
							extreme: source.draw(element<"min" | "max">(["min", "max"])),
							inside: source.draw(element<0 | 1 | 2>([0, 1, 2]))
						})
					]
				])
			),
			flipped: source.draw(boolean)
		})
	],
	[
		1,
		map(
			(source) => [source.draw(int(-2, 4)), source.draw(int(0, 6))] as const,
			([low, width]): Guard => ({ kind: "between", low, high: low + width })
		)
	]
])

const stepGen: Gen<Step> = weighted([
	[4, map(litGen(0, 3), (k): Step => ({ kind: "add", k }))],
	[3, map(litGen(0, 3), (k): Step => ({ kind: "sub", k }))],
	[1, map(litGen(1, 3), (k): Step => ({ kind: "addLeft", k }))],
	[1, element<Step>([{ kind: "copy" }, { kind: "copyTag" }, { kind: "mul" }])],
	[1, element<Step>([{ kind: "addCost" }, { kind: "cost" }, { kind: "costPlus" }])],
	[1, map(litGen(-3, 12), (value): Step => ({ kind: "literal", value }))]
])

const tagGen: Gen<Tag> = weighted([
	[4, map(litGen(0, 3), (value): Tag => ({ kind: "literal", value }))],
	[3, constant<Tag>({ kind: "copy" })],
	[2, element<Tag>([{ kind: "cost" }, { kind: "costPlus" }])],
	[1, constant<Tag>({ kind: "mul" })]
])

const marks = ["a", "b", "c"] as const

const markGen: Gen<Mark> = oneOf([
	map(element(marks), (value): Mark => ({ kind: "literal", value })),
	constant<Mark>({ kind: "copy" })
])

const armGen: Gen<ArmSpec> = (source) => ({
	h: source.draw(stepGen),
	t: source.draw(tagGen),
	m: source.draw(markGen),
	guards: source.draw(array(guardGen, { min: 0, max: 2 })),
	nested: source.draw(boolean),
	pinned: source.draw(
		weighted([
			[4, constant(false)],
			[1, constant(true)]
		])
	)
})

/** What a carrier lets an arm read: the edge's cost is an integer, a vertex's rank a smallint. */
const fitted = (carrier: Carrier, arm: ArmSpec): ArmSpec => {
	const costs = carrier === "integer"
	const h: Step =
		!costs && (arm.h.kind === "addCost" || arm.h.kind === "cost" || arm.h.kind === "costPlus")
			? { kind: "copy" }
			: arm.h
	const t: Tag =
		!costs && (arm.t.kind === "cost" || arm.t.kind === "costPlus") ? { kind: "copy" } : arm.t
	return { ...arm, h, t, pinned: arm.pinned && carrier === "smallint" }
}

const seedsGen = array(
	(source) => ({
		h: source.draw(litGen(-3, 12)),
		t: source.draw(litGen(0, 3)),
		m: source.draw(element(marks))
	}),
	{ min: 1, max: 2 }
)

const populationGen: Gen<Spec> = map(
	(source) => ({
		carrier: source.draw(element<Carrier>(["smallint", "integer", "bigint"])),
		seeds: source.draw(seedsGen),
		arms: source.draw(array(armGen, { min: 1, max: 2 }))
	}),
	(s) => ({ ...s, arms: Arr.map(s.arms, (a) => fitted(s.carrier, a)) })
)

/**
 * An open counter beside a copy of t, whose estimate is its carrier's whole range, which the population reaches only
 * over smallint with every arm bounded, too rarely: over smallint, one arm copies t into h and another steps h by k
 * toward a literal bound, each arm's other parts drawn as the population draws them.
 */
const openCounterGen: Gen<Spec> = map(
	(source) => ({
		seeds: source.draw(seedsGen),
		copy: source.draw(armGen),
		counter: source.draw(armGen),
		k: source.draw(litGen(1, 3)),
		down: source.draw(boolean),
		bound: source.draw(int(-2, 8))
	}),
	({ seeds, copy, counter, k, down, bound }): Spec => {
		const toward: Guard = { kind: "compare", op: down ? "gt" : "lt", bound, flipped: false }
		return {
			carrier: "smallint",
			seeds,
			arms: [
				fitted("smallint", { ...copy, h: { kind: "copyTag" } }),
				fitted("smallint", {
					...counter,
					h: { kind: down ? "sub" : "add", k },
					guards: [toward, ...counter.guards],
					pinned: false
				})
			]
		}
	}
)

/**
 * Data twice in one column, which the population reaches only over integer with two arms reading an edge's cost into
 * t: over integer, two arms whose t reads the cost, each arm's other parts drawn as the population draws them.
 */
const twoCostsGen: Gen<Spec> = map(
	(source) => ({
		seeds: source.draw(seedsGen),
		arms: source.draw((source) => [source.draw(armGen), source.draw(armGen)] as const),
		t: source.draw(
			(source) =>
				[
					source.draw(element<Tag>([{ kind: "cost" }, { kind: "costPlus" }])),
					source.draw(element<Tag>([{ kind: "cost" }, { kind: "costPlus" }]))
				] as const
		)
	}),
	({ seeds, arms, t }): Spec => ({
		carrier: "integer",
		seeds,
		arms: [fitted("integer", { ...arms[0], t: t[0] }), fitted("integer", { ...arms[1], t: t[1] })]
	})
)

/**
 * An estimate a vertex with a self-loop reaches exactly, which the population draws too rarely for the fixpoint to catch
 * an estimate one state short: one seed, a counter stepping by one toward a literal bound that copies t and m, and arms
 * that copy h and t and set a mark, so the fixpoint holds every value of the counter's range with every mark.
 */
const saturatingGen: Gen<Spec> = map(
	(source) => ({
		carrier: source.draw(element<Carrier>(["smallint", "integer", "bigint"])),
		seed: source.draw((source) => ({
			h: source.draw(litGen(-3, 12)),
			t: source.draw(litGen(0, 3)),
			m: source.draw(element(marks))
		})),
		k: source.draw(litGen(1, 1)),
		down: source.draw(boolean),
		inclusive: source.draw(boolean),
		bound: source.draw(int(-2, 8)),
		flipped: source.draw(boolean),
		switches: source.draw(array(element(marks), { min: 0, max: 2 }))
	}),
	({ carrier, seed, k, down, inclusive, bound, flipped, switches }): Spec => {
		const op: Op = down ? (inclusive ? "ge" : "gt") : inclusive ? "le" : "lt"
		return {
			carrier,
			seeds: [seed],
			arms: [
				{
					h: { kind: down ? "sub" : "add", k },
					t: { kind: "copy" },
					m: { kind: "copy" },
					guards: [{ kind: "compare", op, bound, flipped }],
					nested: false,
					pinned: false
				},
				...Arr.map(switches, (value): ArmSpec => ({
					h: { kind: "copy" },
					t: { kind: "copy" },
					m: { kind: "literal", value },
					guards: [],
					nested: false,
					pinned: false
				}))
			]
		}
	}
)

/**
 * A vertex holding more states than the estimate with its data once, which the population draws about one case in
 * 5,000: over integer, one seed, and two arms that copy h and m, one reading the edge's cost into t and the other the
 * cost plus one, so an edge into a vertex gives it two values of t where the estimate counts t's data as one. The
 * estimate with the data once is two, and the root entered by an edge whose cost is neither its seed's t nor one less,
 * or a vertex entered by edges of two costs, holds three states or more.
 */
const costsAtOneVertexGen: Gen<Spec> = map(
	(source) => ({
		h: source.draw(litGen(-3, 12)),
		t: source.draw(litGen(0, 3)),
		m: source.draw(element(marks))
	}),
	(seed): Spec => ({
		carrier: "integer",
		seeds: [seed],
		arms: Arr.map([{ kind: "cost" }, { kind: "costPlus" }] as const, (t): ArmSpec => ({
			h: { kind: "copy" },
			t,
			m: { kind: "copy" },
			guards: [],
			nested: false,
			pinned: false
		}))
	})
)

/**
 * A counter at the carrier's edge, which the population draws a few times a run, too rarely to reach carrier overflow
 * at a literal bound every run: a counter stepping by k toward a literal bound at the extreme it moves to, the extreme
 * or one or two inside it, so its next value leaves the carrier where k passes the room the bound leaves and lands on
 * the extreme or inside it where it does not; the counter's other parts, its other guards and a second arm drawn as the
 * population draws them.
 */
const carrierEdgeGen: Gen<Spec> = map(
	(source) => ({
		carrier: source.draw(element<Carrier>(["smallint", "integer", "bigint"])),
		seeds: source.draw(seedsGen),
		counter: source.draw(armGen),
		k: source.draw(litGen(1, 3)),
		down: source.draw(boolean),
		inclusive: source.draw(boolean),
		inside: source.draw(element<0 | 1 | 2>([0, 1, 2])),
		flipped: source.draw(boolean),
		others: source.draw(array(armGen, { min: 0, max: 1 }))
	}),
	({ carrier, seeds, counter, k, down, inclusive, inside, flipped, others }): Spec => {
		const toward: Guard = {
			kind: "compare",
			op: down ? (inclusive ? "ge" : "gt") : inclusive ? "le" : "lt",
			bound: { extreme: down ? "min" : "max", inside },
			flipped
		}
		return {
			carrier,
			seeds,
			arms: [
				fitted(carrier, {
					...counter,
					h: { kind: down ? "sub" : "add", k },
					guards: [toward, ...counter.guards],
					pinned: false
				}),
				...Arr.map(others, (arm) => fitted(carrier, arm))
			]
		}
	}
)

const specGen: Gen<Spec> = weighted([
	[14, populationGen],
	[1, openCounterGen],
	[1, twoCostsGen],
	[2, saturatingGen],
	[1, costsAtOneVertexGen],
	[1, carrierEdgeGen]
])

const typeOf = (carrier: Carrier): FieldDesc => ({
	kind: "pg",
	type: carrier satisfies PgScalarName
})
const markType: FieldDesc = { kind: "text", source: "^[a-c]$", flags: "u" }

/** The host value a literal of the carrier is spelled in: a bigint for bigint, a number otherwise. */
const host = (carrier: Carrier, value: number): number | bigint =>
	carrier === "bigint" ? BigInt(value) : value

/** A narrower integer type the carrier's literal can be cast from, exactly. */
const narrower: Readonly<Record<Carrier, FieldDesc | undefined>> = {
	smallint: undefined,
	integer: { kind: "pg", type: "smallint" },
	bigint: { kind: "pg", type: "integer" }
}

/** A head literal in its spelling. */
const literal = (carrier: Carrier, l: Lit): ExprDesc => {
	const from = narrower[carrier]
	if (l.spelling === "cast" && from !== undefined) {
		return cast(typedLit(l.value, from), typeOf(carrier))
	}
	return l.spelling === "untyped"
		? lit(host(carrier, l.value))
		: typedLit(host(carrier, l.value), typeOf(carrier))
}

/** An operand literal, typed or untyped. */
const operand = (carrier: Carrier, l: Lit): ExprDesc =>
	l.spelling === "untyped"
		? lit(host(carrier, l.value))
		: typedLit(host(carrier, l.value), typeOf(carrier))

const h = varRef("self.h")
const t = varRef("self.t")
const m = varRef("self.m")
const cost = ref("Edge", "cost")

const flips: Readonly<Record<Op, Op>> = {
	lt: "gt",
	le: "ge",
	eq: "eq",
	ge: "le",
	gt: "lt",
	ne: "ne"
}

/** A literal bound's value in the carrier. */
const boundValue = (carrier: Carrier, bound: number | Edge): bigint => {
	if (typeof bound === "number") {
		return BigInt(bound)
	}
	const [min, max] = ranges[carrier]
	return bound.extreme === "max" ? max - BigInt(bound.inside) : min + BigInt(bound.inside)
}

/** The host value of a carrier's literal, exactly: a bigint for bigint, a number otherwise. */
const exact = (carrier: Carrier, value: bigint): number | bigint =>
	carrier === "bigint" ? value : Number(value)

const guardDesc = (carrier: Carrier, g: Guard): ExprDesc => {
	if (g.kind === "between") {
		return {
			kind: "between",
			arg: h,
			low: lit(host(carrier, g.low)),
			high: lit(host(carrier, g.high))
		}
	}
	if (g.bound === "param") {
		return { kind: "compare", op: g.op, left: h, right: param("max", typeOf(carrier)) }
	}
	const bound = exact(carrier, boundValue(carrier, g.bound))
	return g.flipped
		? { kind: "compare", op: flips[g.op], left: typedLit(bound, typeOf(carrier)), right: h }
		: { kind: "compare", op: g.op, left: h, right: typedLit(bound, typeOf(carrier)) }
}

/**
 * A step h ± k over the current h is a counter, whose exact value the recursion's bound narrows into the carrier; every
 * other integer arithmetic, and a step over a pinned h, which is data, narrows under its guard, as a program writes it.
 */
const stepDesc = (carrier: Carrier, s: Step, pinned: boolean): ExprDesc => {
	const counter = (step: ExprDesc): ExprDesc => (pinned ? narrowed(step, carrier) : step)
	switch (s.kind) {
		case "add":
			return counter(compute("add", h, operand(carrier, s.k)))
		case "addLeft":
			return counter(compute("add", typedLit(host(carrier, s.k.value), typeOf(carrier)), h))
		case "sub":
			return counter(compute("sub", h, operand(carrier, s.k)))
		case "copy":
			return h
		case "copyTag":
			return t
		case "mul":
			return narrowed(compute("mul", h, lit(host(carrier, 2))), carrier)
		case "addCost":
			return narrowed(compute("add", h, cost), carrier)
		case "cost":
			return cost
		case "costPlus":
			return narrowed(compute("add", cost, lit(1)), carrier)
		case "literal":
			return literal(carrier, s.value)
	}
}

const tagDesc = (carrier: Carrier, tag: Tag): ExprDesc => {
	switch (tag.kind) {
		case "literal":
			return literal(carrier, tag.value)
		case "copy":
			return t
		case "cost":
			return cost
		case "costPlus":
			return narrowed(compute("add", cost, lit(1)), carrier)
		case "mul":
			return narrowed(compute("mul", t, lit(host(carrier, 2))), carrier)
	}
}

const recArm = (carrier: Carrier, arm: ArmSpec): RuleDesc => {
	const guards = Arr.map(arm.guards, (g) => guardDesc(carrier, g))
	return rule({
		vars: [
			plainVar("self.node"),
			plainVar("self.h"),
			plainVar("self.t"),
			plainVar("self.m"),
			...vars("Edge", "to", "cost")
		],
		matches: [
			match({ kind: "self" }, { node: varRef("self.node"), h, t, m }),
			match(relationSource("Edge"), { from: varRef("self.node"), to: ref("Edge", "to"), cost }),
			...(arm.pinned ? [match(relationSource("Vertex"), { id: varRef("self.node"), rank: h })] : [])
		],
		where:
			arm.nested && Arr.isReadonlyArrayNonEmpty(guards) && guards.length > 1
				? [{ kind: "and", args: guards }]
				: guards,
		head: {
			node: ref("Edge", "to"),
			h: stepDesc(carrier, arm.h, arm.pinned),
			t: tagDesc(carrier, arm.t),
			m: arm.m.kind === "copy" ? m : lit(arm.m.value)
		},
		interiors: [],
		attach: []
	})
}

const descOfSpec = (spec: Spec): QueryDesc =>
	decodedQuery({
		kind: "recursive",
		recursive: {
			name: "Gen",
			row: {
				node: { kind: "uuid" },
				h: typeOf(spec.carrier),
				t: typeOf(spec.carrier),
				m: markType
			},
			base: Arr.map(nonEmptyList(spec.seeds, "a spec's seeds"), (seed) =>
				rule({
					vars: vars("Vertex", "id"),
					matches: [match(relationSource("Vertex"), { id: ref("Vertex", "id") })],
					where: [eq(ref("Vertex", "id"), param("start", { kind: "uuid" }))],
					head: {
						node: ref("Vertex", "id"),
						h: literal(spec.carrier, seed.h),
						t: literal(spec.carrier, seed.t),
						m: lit(seed.m)
					},
					interiors: [],
					attach: []
				})
			),
			rec: Arr.map(nonEmptyList(spec.arms, "a spec's arms"), (arm) => recArm(spec.carrier, arm))
		}
	})

/** A refusal of admission's rules, or the PartialOperation of a counter's narrowing no bound proves. */
type ModelRefusal =
	| { readonly kind: "carrierOverflow" }
	| { readonly kind: "unboundedState" }
	| { readonly kind: "unprovedNarrowing" }

type Verdict =
	| { readonly kind: "refused"; readonly refusal: ModelRefusal }
	| {
			readonly kind: "admitted"
			readonly family: TerminationCert["kind"]
			readonly estimate: bigint
			readonly counters: boolean
	  }

/**
 * What the rules estimate of a spec before any bound: a refusal they decide first, or the admitted family, its state
 * estimate, whether it counts, and whether its counter's exact step narrows into the carrier: every value the step
 * computes from every state h holds, the counter's least plus its most negative step through its greatest plus its most
 * positive one, lies in the carrier's range.
 */
type Estimate =
	| {
			readonly kind: "refused"
			readonly refusal: Exclude<ModelRefusal, { readonly kind: "unprovedNarrowing" }>
	  }
	| {
			readonly kind: "admitted"
			readonly family: TerminationCert["kind"]
			readonly estimate: bigint
			readonly counters: boolean
			readonly narrows: boolean
	  }

type Form =
	| { readonly kind: "literal"; readonly value: number }
	| { readonly kind: "data" }
	| { readonly kind: "copyOwn" }
	| { readonly kind: "copyTag" }
	| { readonly kind: "own" }
	| { readonly kind: "counter"; readonly delta: bigint; readonly produced: bigint }

/** The last value the guards let a counter moving by `delta` advance from. */
const limitOf = (
	carrier: Carrier,
	guards: ReadonlyArray<Guard>,
	delta: bigint
): bigint | undefined => {
	const [min, max] = ranges[carrier]
	const bounds = Arr.flatMap(guards, (g): ReadonlyArray<readonly [Op, bigint | undefined]> =>
		g.kind === "between"
			? [
					["ge", BigInt(g.low)],
					["le", BigInt(g.high)]
				]
			: g.op === "ne"
				? []
				: [[g.op, g.bound === "param" ? undefined : boundValue(carrier, g.bound)]]
	)
	const ends = Arr.flatMap(bounds, ([op, v]) => {
		const end =
			delta > 0n
				? op === "lt"
					? (v ?? max) - 1n
					: op === "le" || op === "eq"
						? (v ?? max)
						: undefined
				: op === "gt"
					? (v ?? min) + 1n
					: op === "ge" || op === "eq"
						? (v ?? min)
						: undefined
		return end === undefined ? [] : [end]
	})
	return Arr.reduce(ends, undefined, (limit: bigint | undefined, end): bigint | undefined =>
		limit === undefined || (delta > 0n ? end < limit : end > limit) ? end : limit
	)
}

/** A pinned h is data, so every term over it is. */
const hForm = (carrier: Carrier, arm: ArmSpec): Form | "overflow" => {
	const s = arm.h
	switch (s.kind) {
		case "literal":
			return { kind: "literal", value: s.value.value }
		case "copyTag":
			return { kind: "copyTag" }
		case "cost":
		case "costPlus":
			return { kind: "data" }
		case "copy":
			return arm.pinned ? { kind: "data" } : { kind: "copyOwn" }
		case "mul":
		case "addCost":
			return arm.pinned ? { kind: "data" } : { kind: "own" }
		case "add":
		case "addLeft":
		case "sub":
			return arm.pinned
				? { kind: "data" }
				: counterForm(
						carrier,
						arm.guards,
						s.kind === "sub" ? -BigInt(s.k.value) : BigInt(s.k.value)
					)
	}
}

/** A step h ± k under `guards`: a counter, unbounded state without a bound or with a zero step, or an overflow. */
const counterForm = (
	carrier: Carrier,
	guards: ReadonlyArray<Guard>,
	delta: bigint
): Form | "overflow" => {
	if (delta === 0n) {
		return { kind: "own" }
	}
	const limit = limitOf(carrier, guards, delta)
	if (limit === undefined) {
		return { kind: "own" }
	}
	const produced = limit + delta
	const [min, max] = ranges[carrier]
	return produced > max || produced < min ? "overflow" : { kind: "counter", delta, produced }
}

const tForm = (arm: ArmSpec): Form => {
	switch (arm.t.kind) {
		case "literal":
			return { kind: "literal", value: arm.t.value.value }
		case "copy":
			return { kind: "copyOwn" }
		case "cost":
		case "costPlus":
			return { kind: "data" }
		case "mul":
			return { kind: "own" }
	}
}

/**
 * The values a component without a counter takes: its distinct literals, its data's values, and what it copies from
 * other columns.
 */
const plainCount = (forms: ReadonlyArray<Form>, tagFactor: bigint, dataValues: bigint): bigint => {
	const literals = new Set(Arr.flatMap(forms, (f) => (f.kind === "literal" ? [f.value] : [])))
	const data = Arr.some(forms, (f) => f.kind === "data")
	const copied = Arr.filter(forms, (f) => f.kind === "copyTag").length
	const count = BigInt(literals.size) + (data ? dataValues : 0n) + BigInt(copied) * tagFactor
	return count < 1n ? 1n : count
}

/** The values the rules count for a column's data: once, per combination of carrier values. */
const dataCount = 1n

/**
 * How many values a column's data takes: the rules' count, or that count for each distinct value its data forms take
 * over a graph.
 */
type DataValues = Readonly<Record<"h" | "t", bigint>>
const dataOnce: DataValues = { h: dataCount, t: dataCount }

const estimateOf = (spec: Spec): Estimate => estimateWith(spec, dataOnce)

const estimateWith = (spec: Spec, dataValues: DataValues): Estimate => {
	const hForms: Array<Form> = Arr.map(spec.seeds, (s) => ({ kind: "literal", value: s.h.value }))
	const tForms: Array<Form> = Arr.map(spec.seeds, (s) => ({ kind: "literal", value: s.t.value }))
	for (const arm of spec.arms) {
		const form = hForm(spec.carrier, arm)
		if (form === "overflow") {
			return { kind: "refused", refusal: { kind: "carrierOverflow" } }
		}
		hForms.push(form)
		tForms.push(tForm(arm))
	}
	if (Arr.some(hForms, (f) => f.kind === "own") || Arr.some(tForms, (f) => f.kind === "own")) {
		return { kind: "refused", refusal: { kind: "unboundedState" } }
	}
	const tagFactor = plainCount(tForms, 1n, dataValues.t)
	const steps = Arr.flatMap(hForms, (f) => (f.kind === "counter" ? [f] : []))
	let hFactor: bigint
	let narrows = true
	if (steps.length === 0) {
		hFactor = plainCount(hForms, tagFactor, dataValues.h)
	} else {
		const [min, max] = ranges[spec.carrier]
		const inputs = Arr.filter(hForms, (f) => f.kind !== "counter" && f.kind !== "copyOwn")
		const known = Arr.flatMap(inputs, (f) => (f.kind === "literal" ? [BigInt(f.value)] : []))
		/** Every input a literal, and at least one: the counter starts among them, else anywhere in the range. */
		const start =
			known.length === inputs.length && Arr.isReadonlyArrayNonEmpty(known) ? known : undefined
		const lo = Arr.reduce(steps, start === undefined ? min : Arr.min(start, Order.BigInt), (x, s) =>
			s.delta < 0n && s.produced < x ? s.produced : x
		)
		const hi = Arr.reduce(steps, start === undefined ? max : Arr.max(start, Order.BigInt), (x, s) =>
			s.delta > 0n && s.produced > x ? s.produced : x
		)
		hFactor = hi >= lo ? hi - lo + 1n : 1n
		const deltas = Arr.map(steps, (x) => x.delta)
		const least = Arr.reduce(deltas, 0n, (x, d) => (d < x ? d : x))
		const most = Arr.reduce(deltas, 0n, (x, d) => (d > x ? d : x))
		narrows = lo + least >= min && hi + most <= max
	}
	const markLiterals = new Set([
		...Arr.map(spec.seeds, (s) => s.m),
		...Arr.flatMap(spec.arms, (a) => (a.m.kind === "literal" ? [a.m.value] : []))
	])
	return {
		kind: "admitted",
		family:
			steps.length === 0
				? "finiteCarrier"
				: Arr.some(steps, (s) => s.delta > 0n)
					? "boundedState"
					: "wellFounded",
		estimate: hFactor * tagFactor * BigInt(markLiterals.size),
		counters: steps.length > 0,
		narrows
	}
}

/**
 * The verdict: the estimate's refusal, the counter's narrowing left unproved, which admission decides after
 * termination, or the admission, at any estimate.
 */
const verdict = (e: Estimate): Verdict => {
	if (e.kind === "refused") {
		return e
	}
	if (!e.narrows) {
		return { kind: "refused", refusal: { kind: "unprovedNarrowing" } }
	}
	return {
		kind: "admitted",
		family: e.family,
		estimate: e.estimate,
		counters: e.counters
	}
}

/** Whether admission refused for the rule the model decided. */
const sameRefusal = (cause: RecursionRefusal, expected: ModelRefusal): boolean =>
	cause.kind === expected.kind

/**
 * A small graph over Graph's vertices: their ranks and the edges' costs drawn small, so a counter seeded from them stays
 * near its seeds.
 */
interface GraphSketch {
	readonly ranks: ReadonlyArray<number>
	readonly edges: ReadonlyArray<{
		readonly from: number
		readonly to: number
		readonly cost: number
	}>
	readonly start: number
	readonly max: number
}

const graphSketchGen: Gen<GraphSketch> = (source) => ({
	ranks: source.draw(array(int(-2, 6), { min: 1, max: 4 })),
	edges: source.draw(
		array(
			(source) => ({
				from: source.draw(int(0, 0xffff)),
				to: source.draw(int(0, 0xffff)),
				cost: source.draw(int(-2, 4))
			}),
			{ min: 0, max: 6 }
		)
	),
	start: source.draw(int(0, 0xffff)),
	max: source.draw(int(-1, 6))
})

const vertexId = (i: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(String(i), Str.padStart(12, "0"))}`

const defined = <A>(value: A | undefined, what: string): A => {
	if (value === undefined) {
		throw new Error(`no ${what}`)
	}
	return value
}

/** A value of a column's type, for the columns a definition stores but never reads. */
const filler = (type: ScalarType, i: number): TypedLiteral => {
	const base = baseOf(type)
	switch (base.carrier) {
		case "uuid":
			return { kind: "uuid", value: vertexId(i) }
		case "date":
			return { kind: "date", value: `${String(1 + i).padStart(4, "0")}-01-01` }
		case "text":
			return { kind: "text", value: `v${i}` }
		case "bool":
			return { kind: "bool", value: true }
		case "code":
			return { kind: "handle", handle: defined(base.roster.handles[0], "a roster handle") }
		case "bits":
			return { kind: "handles", handles: [] }
		case "int2":
		case "int4":
		case "int8":
			return { kind: "int", value: BigInt(i) }
		case "money":
			return { kind: "money", value: defined(MoneyText.parse(String(i)), `the money text ${i}`) }
		case "numeric":
			return {
				kind: "numeric",
				value: defined(DecimalText.parse(`${i}`), `the decimal text ${i}`)
			}
		case "float4":
		case "float8":
		case "range4":
		case "range8":
		case "vector":
		case "exactInteger":
		case "exactMoney":
			throw new Error(`no filler for a ${base.carrier} column`)
	}
}

/** The relations the checked definition reads, as the reference reads them: each with the heading its scan holds. */
const schemaOf = (q: LogicalQuery): GenSchema => {
	const relations = new Map<string, Heading>()
	for (const n of topoOrder(q.dag)) {
		if (n.kind === "Base") {
			relations.set(n.relation, n.heading)
		}
	}
	return {
		name: "Graph",
		relations: Arr.map([...relations], ([name, columns]) => ({
			name,
			columns,
			primaryKey: name === "Edge" ? ["from", "to"] : ["id"],
			keys: [],
			mutable: false
		})),
		closed: [],
		containments: []
	}
}

/**
 * The graph's edges between its vertices, by index, one per pair: a later sketch edge between a pair replaces an
 * earlier one.
 */
const graphEdges = (
	g: GraphSketch
): ReadonlyArray<{ readonly from: number; readonly to: number; readonly cost: number }> => {
	const [first, ...rest] = [...indices(g.ranks.length)]
	const pairs = new Map<string, { from: number; to: number; cost: number }>()
	if (first !== undefined) {
		for (const e of g.edges) {
			const from = pickFrom([first, ...rest], e.from)
			const to = pickFrom([first, ...rest], e.to)
			pairs.set(`${from} ${to}`, { from, to, cost: e.cost })
		}
	}
	return [...pairs.values()]
}

/**
 * The value an arm delivers for h over an edge where h is data, from the edge's cost and the rank of the vertex it
 * leaves, which a pinned h is bound to; undefined where the arm's h is no data (hForm).
 */
const hDatum = (arm: ArmSpec, rank: bigint, edgeCost: bigint): bigint | undefined => {
	const s = arm.h
	switch (s.kind) {
		case "cost":
			return edgeCost
		case "costPlus":
			return edgeCost + 1n
		case "literal":
		case "copyTag":
			return undefined
		case "copy":
			return arm.pinned ? rank : undefined
		case "mul":
			return arm.pinned ? rank * 2n : undefined
		case "addCost":
			return arm.pinned ? rank + edgeCost : undefined
		case "add":
		case "addLeft":
			return arm.pinned ? rank + BigInt(s.k.value) : undefined
		case "sub":
			return arm.pinned ? rank - BigInt(s.k.value) : undefined
	}
}

/** The value an arm delivers for t over an edge where t is data; undefined where it is no data (tForm). */
const tDatum = (arm: ArmSpec, edgeCost: bigint): bigint | undefined =>
	arm.t.kind === "cost" ? edgeCost : arm.t.kind === "costPlus" ? edgeCost + 1n : undefined

/** The distinct values each column's data takes over a graph's edges, every arm's data forms together. */
const dataValuesOver = (spec: Spec, g: GraphSketch): DataValues => {
	const data = Arr.flatMap([...graphEdges(g)], (e) => {
		const rank = BigInt(defined(g.ranks[e.from], "the rank of an edge's vertex"))
		return Arr.map(spec.arms, (arm) => ({
			hd: hDatum(arm, rank, BigInt(e.cost)),
			td: tDatum(arm, BigInt(e.cost))
		}))
	})
	const hs = new Set(Arr.flatMap(data, ({ hd }) => (hd === undefined ? [] : [hd])))
	const ts = new Set(Arr.flatMap(data, ({ td }) => (td === undefined ? [] : [td])))
	return { h: dataCount * BigInt(hs.size), t: dataCount * BigInt(ts.size) }
}

/** The graph's facts: each vertex its rank, each edge between two vertices its cost, one edge per pair. */
const factsOf = (schema: GenSchema, g: GraphSketch): GenFacts => {
	const columnsOf = (name: string) =>
		Option.match(
			Arr.findFirst(schema.relations, (r) => r.name === name),
			{ onNone: () => [], onSome: (r) => r.columns }
		)
	const vertices = Arr.map(g.ranks, (rank, i) =>
		Arr.map(columnsOf("Vertex"), (c): TypedLiteral =>
			c.name === "rank" ? { kind: "int", value: BigInt(rank) } : filler(c.type, i)
		)
	)
	const edges = Arr.map(graphEdges(g), (e) =>
		Arr.map(columnsOf("Edge"), (c): TypedLiteral => {
			if (c.name === "from") {
				return { kind: "uuid", value: vertexId(e.from) }
			}
			if (c.name === "to") {
				return { kind: "uuid", value: vertexId(e.to) }
			}
			if (c.name === "cost") {
				return { kind: "int", value: BigInt(e.cost) }
			}
			return filler(c.type, e.from)
		})
	)
	return canonicalFacts({ Vertex: vertices, Edge: edges, Blocked: [] })
}

/** The parameters the definition reads: the root vertex and the guards' bound, each at its declared type. */
const paramsOf = (q: LogicalQuery, g: GraphSketch): Readonly<Record<string, GenParam>> =>
	Rec.fromEntries(
		Arr.map(q.params, (p): readonly [string, GenParam] => {
			const type = defined(paramColumns(p)[0], `the type of ${p.name}`).type
			const value: TypedLiteral =
				baseOf(type).carrier === "uuid"
					? { kind: "uuid", value: vertexId(pickIndex(g.start, g.ranks.length)) }
					: { kind: "int", value: BigInt(g.max) }
			return [p.id, { kind: "scalar", type, value }]
		})
	)

/** The most distinct states any vertex carries at the fixpoint, which must reach it. */
const statesPerVertex = (
	q: LogicalQuery,
	recursive: NodeOf<"Recursive">,
	g: GraphSketch
): number => {
	const schema = schemaOf(q)
	const reference = Reference.of(q.dag, {
		schema,
		facts: factsOf(schema, g),
		params: paramsOf(q, g),
		observer: unobserved
	})
	const states = reference.eval(recursive, noBindings)
	const node = Option.getOrThrowWith(
		Arr.findFirstIndex(states.heading, (c) => c.name === "node"),
		() => new Error("a column the case's own heading holds")
	)
	const perVertex = new Map<string, Set<string>>()
	for (const row of states.rows) {
		const vertex = Formatter.format(row[node])
		const state = Arr.join(
			Arr.flatMap(row, (v, i) =>
				i === node
					? []
					: [
							valueKey(
								defined(v, "a state value"),
								defined(states.heading[i], "a state column").type
							)
						]
			),
			"\u0000"
		)
		const known = perVertex.get(vertex)
		if (known === undefined) {
			perVertex.set(vertex, new Set([state]))
		} else {
			known.add(state)
		}
	}
	return maxOf(
		Arr.map([...perVertex.values()], (set) => set.size),
		0
	)
}

/** The features the population must reach, by name, each with the specs that reach it. */
const featureTests = [
	["finiteCarrier", ({ verdict: v }) => v.kind === "admitted" && v.family === "finiteCarrier"],
	["boundedState", ({ verdict: v }) => v.kind === "admitted" && v.family === "boundedState"],
	["wellFounded", ({ verdict: v }) => v.kind === "admitted" && v.family === "wellFounded"],
	[
		"carrier overflow",
		({ verdict: v }) => v.kind === "refused" && v.refusal.kind === "carrierOverflow"
	],
	[
		"carrier overflow at a literal bound",
		({ spec: s, verdict: v }) =>
			v.kind === "refused" &&
			v.refusal.kind === "carrierOverflow" &&
			Arr.some(s.arms, (a) =>
				Arr.some(a.guards, (g) => g.kind === "compare" && typeof g.bound === "object")
			)
	],
	[
		"unbounded computed state",
		({ verdict: v }) => v.kind === "refused" && v.refusal.kind === "unboundedState"
	],
	[
		"a pinned counter",
		({ spec: s, verdict: v }) =>
			v.kind === "admitted" && Arr.some(s.arms, (a) => a.pinned && a.h.kind !== "literal")
	],
	[
		"a counter beside a copy of t, which leaves its narrowing unproved",
		({ spec: s, verdict: v }) =>
			v.kind === "refused" &&
			v.refusal.kind === "unprovedNarrowing" &&
			Arr.some(s.arms, (a) => a.h.kind === "copyTag")
	],
	[
		"a narrowing unproved one step past a literal bound",
		({ spec: s, verdict: v }) =>
			v.kind === "refused" &&
			v.refusal.kind === "unprovedNarrowing" &&
			Arr.every(
				s.arms,
				(a) =>
					!a.pinned &&
					a.h.kind !== "copyTag" &&
					Arr.every(a.guards, (g) => g.kind === "between" || g.bound !== "param")
			)
	],
	[
		"a bigint seed cast from an integer beside an equal one spelled otherwise",
		({ spec: s }) => {
			const tags = [
				...Arr.map(s.seeds, (x) => x.t),
				...Arr.flatMap(s.arms, (a) => (a.t.kind === "literal" ? [a.t.value] : []))
			]
			return (
				s.carrier === "bigint" &&
				Arr.some(
					tags,
					(x) =>
						x.spelling === "cast" &&
						Arr.some(tags, (y) => x.value === y.value && y.spelling !== "cast")
				)
			)
		}
	],
	[
		"two marks",
		({ spec: s }) =>
			new Set([
				...Arr.map(s.seeds, (x) => x.m),
				...Arr.flatMap(s.arms, (a) => (a.m.kind === "literal" ? [a.m.value] : []))
			]).size > 1
	],
	[
		"two bounds on the side a counter moves",
		({ spec: s, verdict: v }) =>
			v.kind === "admitted" &&
			v.counters &&
			Arr.some(
				s.arms,
				(a) => Arr.filter(a.guards, (g) => g.kind === "compare" && g.op !== "ne").length > 1
			)
	],
	[
		"a seed past the counter's bound",
		({ spec: s, verdict: v }) =>
			v.kind === "admitted" &&
			v.counters &&
			Arr.some(s.arms, (a) =>
				Arr.some(
					a.guards,
					(g) =>
						g.kind === "compare" &&
						typeof g.bound === "number" &&
						Arr.some(s.seeds, (x) => typeof g.bound === "number" && x.h.value > g.bound)
				)
			)
	],
	[
		"data twice in one column",
		({ spec: s }) =>
			Arr.filter(s.arms, (a) => a.t.kind === "cost" || a.t.kind === "costPlus").length > 1
	]
] as const satisfies ReadonlyArray<
	readonly [string, (subject: { readonly spec: Spec; readonly verdict: Verdict }) => boolean]
>

type CertificateFeature =
	| (typeof featureTests)[number][0]
	| "a fixpoint reached"
	| "a fixpoint at its estimate"
	| "a vertex holding more states than the estimate with its data once"
	| "a fixpoint past the reference's step limit"

type CertificateCase = readonly [Spec, ReadonlyArray<GraphSketch>]

const kept: ReadonlyArray<Kept<CertificateCase, CertificateFeature>> = [
	{
		note: "a counter stepping by -3 toward a bound near smallint's minimum reaches the minimum, from where its next step leaves smallint: once admitted with 131116 states per vertex, and the reference's fixpoint over them ran for an hour",
		sketch: [
			{
				carrier: "smallint",
				seeds: [
					{ h: { value: 3, spelling: "untyped" }, t: { value: 1, spelling: "untyped" }, m: "a" },
					{ h: { value: 10, spelling: "untyped" }, t: { value: 0, spelling: "cast" }, m: "a" }
				],
				arms: [
					{
						h: { kind: "sub", k: { value: 3, spelling: "typed" } },
						t: { kind: "copy" },
						m: { kind: "literal", value: "a" },
						guards: [
							{ kind: "compare", op: "gt", bound: { extreme: "min", inside: 2 }, flipped: true }
						],
						nested: true,
						pinned: false
					},
					{
						h: { kind: "sub", k: { value: 3, spelling: "typed" } },
						t: { kind: "copy" },
						m: { kind: "literal", value: "b" },
						guards: [{ kind: "between", low: 4, high: 8 }],
						nested: false,
						pinned: false
					}
				]
			},
			[
				{
					ranks: [1, 1, -2],
					edges: [
						{ from: 9, to: 14, cost: 2 },
						{ from: 58455, to: 61315, cost: 2 },
						{ from: 8839, to: 7037, cost: -1 },
						{ from: 56985, to: 2829, cost: -1 },
						{ from: 7334, to: 25523, cost: 4 },
						{ from: 34320, to: 34161, cost: 3 }
					],
					start: 65227,
					max: 5
				}
			]
		],
		draws: "",
		reaches: ["a narrowing unproved one step past a literal bound"]
	},
	{
		note: "plants a fixpoint at its estimate: a counter stepping by 1 to a literal bound, with a mark switch, over a self-loop",
		sketch: [
			{
				carrier: "smallint",
				seeds: [{ h: { value: 0, spelling: "typed" }, t: { value: 0, spelling: "typed" }, m: "a" }],
				arms: [
					{
						h: { kind: "add", k: { value: 1, spelling: "typed" } },
						t: { kind: "copy" },
						m: { kind: "copy" },
						guards: [{ kind: "compare", op: "lt", bound: 3, flipped: false }],
						nested: false,
						pinned: false
					},
					{
						h: { kind: "copy" },
						t: { kind: "copy" },
						m: { kind: "literal", value: "b" },
						guards: [],
						nested: false,
						pinned: false
					}
				]
			},
			[{ ranks: [0], edges: [{ from: 0, to: 0, cost: 0 }], start: 0, max: 0 }]
		],
		draws: "",
		reaches: ["boundedState", "a fixpoint reached", "a fixpoint at its estimate"]
	},
	{
		note: "plants a carrier overflow at a literal bound: a counter stepping by 3 below smallint's maximum less one, which the drawn guards reach a few times a run",
		sketch: [
			{
				carrier: "smallint",
				seeds: [{ h: { value: 0, spelling: "typed" }, t: { value: 0, spelling: "typed" }, m: "a" }],
				arms: [
					{
						h: { kind: "add", k: { value: 3, spelling: "typed" } },
						t: { kind: "copy" },
						m: { kind: "copy" },
						guards: [
							{ kind: "compare", op: "lt", bound: { extreme: "max", inside: 1 }, flipped: false }
						],
						nested: false,
						pinned: false
					}
				]
			},
			[{ ranks: [0], edges: [{ from: 0, to: 0, cost: 0 }], start: 0, max: 0 }]
		],
		draws: "",
		reaches: ["carrier overflow", "carrier overflow at a literal bound"]
	},
	{
		note: "two arms read an edge's cost and the cost plus one into t, and a vertex entered by edges of costs 1 and -1 holds 7 states, which the estimate, counting t's data once, puts at 6: the fixpoint compared a vertex with the data once",
		sketch: [
			{
				carrier: "integer",
				seeds: [{ h: { value: 1, spelling: "typed" }, t: { value: 0, spelling: "typed" }, m: "a" }],
				arms: [
					{
						h: { kind: "sub", k: { value: 1, spelling: "typed" } },
						t: { kind: "cost" },
						m: { kind: "copy" },
						guards: [{ kind: "compare", op: "ge", bound: 0, flipped: false }],
						nested: false,
						pinned: false
					},
					{
						h: { kind: "sub", k: { value: 1, spelling: "typed" } },
						t: { kind: "costPlus" },
						m: { kind: "copy" },
						guards: [{ kind: "compare", op: "ge", bound: 0, flipped: false }],
						nested: false,
						pinned: false
					}
				]
			},
			[
				{
					ranks: [0, 0],
					edges: [
						{ from: 32768, to: 32768, cost: 1 },
						{ from: 32768, to: 0, cost: 0 },
						{ from: 0, to: 32768, cost: -1 }
					],
					start: 32768,
					max: 0
				}
			]
		],
		draws: "",
		reaches: [
			"wellFounded",
			"data twice in one column",
			"a fixpoint reached",
			"a vertex holding more states than the estimate with its data once"
		]
	}
]

describe("generated recursions against the termination proof rules", () => {
	it.effect(
		"gives every generated definition the verdict, family and estimate the rules give it, and no vertex more states than the estimate at the fixpoint",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/recursion/certificates",
						draw: sketched(
							(source) =>
								[
									source.draw(specGen),
									source.draw(array(graphSketchGen, { min: 1, max: 2 }))
								] as const,
							(sketch) => sketch
						),
						literal: Formatter.format,
						coverage: required<CertificateFeature>(
							[
								...Arr.map(featureTests, ([name]) => name),
								"a fixpoint reached",
								"a fixpoint at its estimate",
								"a vertex holding more states than the estimate with its data once",
								"a fixpoint past the reference's step limit"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept,
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([spec, graphs], c) =>
						Effect.sync(() => {
							const estimate = estimateOf(spec)
							const expected = verdict(estimate)
							c.noteAll(
								Arr.flatMap(featureTests, ([name, has]) =>
									has({ spec, verdict: expected }) ? [name] : []
								)
							)
							const r = checkQuery(checking(Graph), descOfSpec(spec), checkOptions("query"))
							if (expected.kind === "refused") {
								if (r.ok) {
									throw new Error(`admitted, not refused for ${expected.refusal.kind}`)
								}
								if (expected.refusal.kind === "unprovedNarrowing") {
									if (r.error.reason._tag !== "PartialOperation") {
										throw new Error(`${r.error.message}, not an unproved narrowing`)
									}
									return
								}
								if (
									r.error.reason._tag !== "RecursionRefused" ||
									!sameRefusal(r.error.reason.cause, expected.refusal)
								) {
									throw new Error(`${r.error.message}, not ${expected.refusal.kind}`)
								}
								return
							}
							if (!r.ok) {
								throw new Error(`${r.error.message}, not admitted`)
							}
							const recursive = theRecursive(r.value)
							const cert = recursive.termination
							if (
								cert.kind !== expected.family ||
								cert.stateEstimate !== expected.estimate ||
								cert.premises.length !== (expected.counters ? 1 : 0)
							) {
								throw new Error(
									`${cert.kind} with estimate ${cert.stateEstimate}, not ${expected.family} with ${expected.estimate}`
								)
							}
							for (const g of graphs) {
								/** The estimate over the graph: each column's data counts the values it takes on the graph's edges. */
								const over = estimateWith(spec, dataValuesOver(spec, g))
								if (over.kind === "refused") {
									throw new Error(`refused for ${over.refusal.kind} over a graph`)
								}
								if (over.estimate * BigInt(g.ranks.length) > BigInt(maxIterations)) {
									c.note("a fixpoint past the reference's step limit")
									continue
								}
								const reached = BigInt(statesPerVertex(r.value, recursive, g))
								c.note("a fixpoint reached")
								if (reached > over.estimate) {
									throw new Error(
										`a vertex carries ${reached} states at the fixpoint, above the estimate ${over.estimate} over the graph's data (${cert.stateEstimate} with its data once)`
									)
								}
								if (reached === over.estimate) {
									c.note("a fixpoint at its estimate")
								}
								if (reached > cert.stateEstimate) {
									c.note("a vertex holding more states than the estimate with its data once")
								}
							}
						})
				)
			)
	)
})
