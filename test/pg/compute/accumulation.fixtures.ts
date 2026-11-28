import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	recorded,
	steered,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option } from "effect"
import { floatLiteral } from "#compiler/ir/carriers.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import * as N from "#compiler/scalar/compute/numeric.ts"
import { plainType } from "#compiler/scalar/native.ts"
import type { Numeric } from "#compiler/scalar/values/decimal.ts"

import { assert } from "@bjornpagen/testing/assert"
import { Money } from "#compiler/scalar/values/money.ts"
import type {
	AuthoredExprDesc as ExprDesc,
	HeadTermDesc,
	QueryDesc
} from "#test/support/fixtures/ir/desc.ts"
import { valueClasses } from "#test/support/oracle/gen/domain.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import { type GenSchema, schemaDesc } from "#test/support/oracle/gen/schema.ts"
import {
	forcedParallel,
	forcesParallel,
	type Perturbation,
	perturbationGen,
	printPerturbation,
	unperturbed
} from "#test/support/oracle/perturb.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { exactDouble } from "#test/support/oracle/reference/aggregate.ts"
import {
	defaultRunOptions,
	type LabelledCase,
	type Lowering,
	printOutcome,
	reference,
	runLabelledOracle
} from "#test/support/oracle/runner.ts"
import { checkAuthored, checking, checkOptions } from "#test/support/policy.ts"
import * as D from "#test/support/unit/check/dsl.ts"

export type OrderSituation =
	| "float sum whose IEEE orders disagree"
	| "float mean whose IEEE orders disagree"
	| "money sum overflowing in some order but not in total"
	| "float sum overflowing in some order but not in total"
	| "aggregate under forced parallel plans"

const int4 = plainType("int4")
const int8 = plainType("int8")
const float8 = plainType("float8")
const float4 = plainType("float4")
const money = plainType("money")

/** Entry(id, grp, x double precision, r real, cash money). */
const ledger: GenSchema = {
	name: "Ledger",
	relations: [
		{
			name: "Entry",
			columns: [
				{ name: "id", type: int8 },
				{ name: "grp", type: int4 },
				{ name: "x", type: float8 },
				{ name: "r", type: float4 },
				{ name: "cash", type: money }
			],
			primaryKey: ["id"],
			keys: [],
			mutable: false
		}
	],
	closed: [],
	containments: []
}

/** One drawn entry: its group, a float of each width, and an amount in cents. */
interface Entry {
	readonly grp: number
	readonly x: TypedLiteral
	readonly r: TypedLiteral
	readonly cents: bigint
}

/** The lab's sittings, [id, student, day, score], for R41's running total. */
type Sitting = readonly [number, number, number, number]

interface AccumulationCase {
	readonly entries: ReadonlyArray<Entry>
	readonly sittings: ReadonlyArray<Sitting>
	readonly perturbation: Perturbation
}

/** A float type's edge classes: its finite values, and the specials NaN and ±Infinity, a sixteenth of draws. */
const floatOf = (type: ScalarType): Gen<TypedLiteral> => {
	const classes = valueClasses(type, true)
	return weighted<TypedLiteral>([
		[
			15,
			element(
				nonEmptyList(
					Arr.filter(classes, (l) => l.kind === "float"),
					"finite floats"
				)
			)
		],
		[
			1,
			element(
				nonEmptyList(
					Arr.filter(classes, (l) => l.kind === "floatSpecial"),
					"specials"
				)
			)
		]
	])
}

const finiteDoubles = nonEmptyList(
	Arr.flatMap(valueClasses(float8, true), (l): ReadonlyArray<number> =>
		l.kind === "float" ? [l.value] : []
	),
	"finite doubles"
)

const amounts = nonEmptyList(
	Arr.flatMap(valueClasses(money, true), (l): ReadonlyArray<bigint> =>
		l.kind === "money" ? [l.value.minorUnits] : []
	),
	"amounts"
)

const entryGen: Gen<Entry> = (source) => ({
	grp: source.draw(int(1, 3)),
	x: source.draw(floatOf(float8)),
	r: source.draw(floatOf(float4)),
	cents: source.draw(element(amounts))
})

const sittingGen: Gen<readonly [number, number, number]> = (source) => [
	source.draw(int(1, 3)),
	source.draw(int(1, 8)),
	source.draw(element(finiteDoubles))
]

const caseGen: Gen<AccumulationCase> = (source) => ({
	entries: source.draw(array(entryGen, { min: 1, max: 40 })),
	sittings: Arr.map(
		source.draw(array(sittingGen, { min: 1, max: 30 })),
		([student, day, score], k): Sitting => [k + 1, student, day, score]
	),
	perturbation: source.draw(
		weighted<Perturbation>([
			[3, perturbationGen],
			[1, constant(forcedParallel)]
		])
	)
})

const e = (field: string): ExprDesc => D.ref("Entry", field)

const mean = (arg: ExprDesc): HeadTermDesc => ({ kind: "aggregate", fn: "mean", arg })

/** A query over every entry, grouped by grp where `grouped`, with the head's aggregates. */
const over = (grouped: boolean, head: Readonly<Record<string, HeadTermDesc>>): QueryDesc =>
	D.queryDesc(
		D.rule({
			vars: D.vars("Entry", "id", "grp", "x", "r", "cash"),
			matches: [
				D.match(D.relationSource("Entry"), {
					id: e("id"),
					grp: e("grp"),
					x: e("x"),
					r: e("r"),
					cash: e("cash")
				})
			],
			head: grouped ? { grp: e("grp"), ...head } : head,
			where: [],
			interiors: [],
			attach: []
		})
	)

/** Each sum alone, per group; every sum and mean in one head, per group and over every entry. */
export const ledgerQueries: ReadonlyArray<readonly [string, QueryDesc]> = [
	["double precision sum", over(true, { s: D.sum(e("x")) })],
	["real sum", over(true, { s: D.sum(e("r")) })],
	["money sum", over(true, { s: D.sum(e("cash")) })],
	[
		"every sum and mean in one head",
		over(true, {
			sx: D.sum(e("x")),
			mx: mean(e("x")),
			sr: D.sum(e("r")),
			mr: mean(e("r")),
			sc: D.sum(e("cash")),
			n: D.count()
		})
	],
	[
		"the totals in one head",
		over(false, { sx: D.sum(e("x")), mr: mean(e("r")), sc: D.sum(e("cash")) })
	]
]

const literalOf = (x: Entry, id: number): ReadonlyArray<TypedLiteral> => [
	{ kind: "int", value: BigInt(id) },
	{ kind: "int", value: BigInt(x.grp) },
	x.x,
	x.r,
	{ kind: "money", value: Money.of(x.cents) }
]

export const ledgerCase = (
	label: string,
	desc: QueryDesc,
	entries: ReadonlyArray<Entry>
): LabelledCase => {
	const checked = checkAuthored(checking(schemaDesc(ledger)), desc, checkOptions("query"))
	if (!checked.ok) {
		throw new Error(`${label} does not check: ${checked.error.message}`)
	}
	return {
		label,
		schema: ledger,
		facts: canonicalFacts({ Entry: Arr.map(entries, (x, k) => literalOf(x, k + 1)) }),
		query: { dag: checked.value.dag, params: {} },
		spelling: { mode: "drawn", edge: true }
	}
}

/** The groups of the drawn entries, each in storage order. */
const groupsOf = (entries: ReadonlyArray<Entry>): ReadonlyArray<ReadonlyArray<Entry>> =>
	Arr.map([1, 2, 3], (g) => Arr.filter(entries, (x) => x.grp === g))

/** A group's values of one float field, or none where it is empty or holds a special, which absorbs in every order. */
const finiteValues = (
	group: ReadonlyArray<Entry>,
	field: (x: Entry) => TypedLiteral
): Arr.NonEmptyReadonlyArray<number> | undefined => {
	const out: Array<number> = []
	for (const x of group) {
		const v = field(x)
		if (v.kind !== "float") {
			return undefined
		}
		out.push(v.value)
	}
	return Arr.isReadonlyArrayNonEmpty(out) ? out : undefined
}

/** A sequential IEEE sum in one order: its total, and whether a partial sum overflowed on the way. */
interface Sequential {
	readonly total: number
	readonly overflowed: boolean
}

/** The sequential IEEE sum of `xs` in their order, each step rounded by `round`. */
const sequential = (xs: ReadonlyArray<number>, round: (x: number) => number): Sequential => {
	let total = 0
	let overflowed = false
	for (const y of xs) {
		total = round(total + y)
		overflowed = overflowed || !Number.isFinite(total)
	}
	return { total, overflowed }
}

const differ = (a: number, b: number): boolean => !Object.is(a, b)

/** A double precision step: IEEE binary64 addition rounds every step already. */
const inDouble = (y: number): number => y

/** The exact sum of finite doubles, rounded once to the nearest double. */
const roundedTotal = (xs: Arr.NonEmptyReadonlyArray<number>): number => {
	const total = Arr.reduce(
		Arr.tailNonEmpty(xs),
		exactDouble(Arr.headNonEmpty(xs)),
		(t: Numeric, x): Numeric => {
			const sum = N.add(t, exactDouble(x))
			if (!sum.ok) {
				throw new Error(`no exact sum: ${sum.error}`)
			}
			return sum.value
		}
	)
	return Number(total.text)
}

const int64 = Object.freeze({ lo: -(2n ** 63n), hi: 2n ** 63n - 1n })

/** Whether a sequential int64 sum of `cents` in this order leaves int64 at some step. */
const leavesInt64 = (cents: ReadonlyArray<bigint>): boolean => {
	let total = 0n
	for (const c of cents) {
		total += c
		if (total < int64.lo || total > int64.hi) {
			return true
		}
	}
	return false
}

/** The order situations the drawn values reach, computed from the values alone. */
export const situationsOf = (c: AccumulationCase): ReadonlyArray<OrderSituation> => {
	const out = new Set<OrderSituation>()
	if (forcesParallel(c.perturbation)) {
		out.add("aggregate under forced parallel plans")
	}
	for (const group of groupsOf(c.entries)) {
		for (const [field, round] of [
			[(x: Entry) => x.x, inDouble],
			[(x: Entry) => x.r, Math.fround]
		] as const) {
			const xs = finiteValues(group, field)
			if (xs === undefined) {
				continue
			}
			const backward = Arr.reverse(xs)
			if (differ(sequential(xs, round).total, sequential(backward, round).total)) {
				out.add("float sum whose IEEE orders disagree")
			}
			const n = xs.length
			if (differ(sequential(xs, inDouble).total / n, sequential(backward, inDouble).total / n)) {
				out.add("float mean whose IEEE orders disagree")
			}
		}
		const doubles = finiteValues(group, (x) => x.x)
		if (doubles !== undefined) {
			const overflows =
				sequential(doubles, inDouble).overflowed ||
				sequential(Arr.reverse(doubles), inDouble).overflowed
			if (overflows && Number.isFinite(roundedTotal(doubles))) {
				out.add("float sum overflowing in some order but not in total")
			}
		}
		const cents = Arr.map(group, (x) => x.cents)
		const total = Arr.reduce(cents, 0n, (a, b) => a + b)
		if (
			(leavesInt64(cents) || leavesInt64(Arr.reverse(cents))) &&
			total >= int64.lo &&
			total <= int64.hi
		) {
			out.add("money sum overflowing in some order but not in total")
		}
	}
	return Arr.fromIterable(out)
}

/**
 * Groups whose sequential double sum overflows in their order, a partial sum past DBL_MAX, while the exact total is
 * DBL_MAX or its negation, finite.
 */
const overflowingGroups: Arr.NonEmptyReadonlyArray<ReadonlyArray<number>> = [
	[Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE],
	[-Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE],
	[Number.MAX_VALUE, 1, Number.MAX_VALUE, -Number.MAX_VALUE]
]

/**
 * A case as the generator draws it, beside the issue's ledgers (issueLedgers, gen.ts recorded), aimed at what no witness has reached yet (gen.ts steered), each pending situation in half
 * its cases by a draw of its own: its plans forced parallel, and its third group drawn from overflowingGroups in place
 * of its own; a rotating case is drawn unaimed. The situations are computed from the case, so a note never claims what
 * the case does not hold.
 */
export const accumulationCases = steered<AccumulationCase, OrderSituation>((steering) =>
	recorded((source) => {
		const k = source.draw(caseGen)
		return Option.match(steering, {
			onNone: () => k,
			onSome: (pending) => ({
				...k,
				entries:
					pending.has("float sum overflowing in some order but not in total") &&
					source.draw(boolean)
						? [
								...Arr.filter(k.entries, (x) => x.grp !== 3),
								...Arr.map(source.draw(element(overflowingGroups)), (x) => plainEntry(3, x, 0n))
							]
						: k.entries,
				perturbation:
					pending.has("aggregate under forced parallel plans") && source.draw(boolean)
						? forcedParallel
						: k.perturbation
			})
		})
	}, issueLedgers)
)

const double = (x: number): TypedLiteral => floatLiteral(x)

const plainEntry = (grp: number, x: number, cents: bigint): Entry => ({
	grp,
	x: double(x),
	r: double(Math.fround(x)),
	cents
})

/**
 * The issue's aggregation cases (b35c479bb), kept by value, since the space draws no real at fround(1e20) and no double
 * beside its edge classes' (toolchain-test keep finds none): r.sum and r.mean over {1e20, 1, -1e20, 0.1, 0.2, 0.3},
 * stored in that order and in reverse, which deliver 1.6 and 0.26666666666666666 from every side; and r.sum over money
 * {92233720368547758.07, 0.01, -0.01}, which delivers 92233720368547758.07 and never 22003, under forced parallel plans.
 */
const issueLedgers: Arr.NonEmptyReadonlyArray<AccumulationCase> = [
	{
		entries: Arr.map([1e20, 1, -1e20, 0.1, 0.2, 0.3], (x) => plainEntry(1, x, 0n)),
		sittings: Arr.map([1e20, 1, -1e20, 0.1, 0.2, 0.3], (x, k): Sitting => [k + 1, 1, k + 1, x]),
		perturbation: unperturbed
	},
	{
		entries: Arr.map([0.3, 0.2, 0.1, -1e20, 1, 1e20], (x) => plainEntry(1, x, 0n)),
		sittings: Arr.map([0.3, 0.2, 0.1, -1e20, 1, 1e20], (x, k): Sitting => [k + 1, 1, k + 1, x]),
		perturbation: forcedParallel
	},
	{
		entries: Arr.map([2n ** 63n - 1n, 1n, -1n], (cents) => plainEntry(1, 0, cents)),
		sittings: [[1, 1, 1, 0]],
		perturbation: unperturbed
	}
]

/**
 * Judges a lowering's delivery of a labelled case against the exact reference, under the case's perturbation, in the
 * schema `schema`.
 */
export const judged = (
	label: string,
	lowered: LabelledCase,
	side: Lowering,
	p: Perturbation,
	schema: string
) =>
	Effect.gen(function* () {
		const outcome = yield* runLabelledOracle(lowered, side, reference, {
			...defaultRunOptions,
			schema: { kind: "named", name: schema }
		})
		assert.equal(
			outcome.comparison.equal,
			true,
			`${label}\n${printOutcome(outcome)}\n${printPerturbation(p)}`
		)
	})
