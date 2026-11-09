import { layer } from "@effect/vitest"
import { type Case, drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, constant, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import * as N from "#compiler/scalar/compute/numeric.ts"
import { plainType } from "#compiler/scalar/native.ts"
import type { Decimal } from "#compiler/scalar/values/decimal.ts"
import { canonicalZero } from "#compiler/scalar/values/float.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import * as Q from "#test/pg/catalog/queries.ts"
import {
	appliedRules,
	catalogLowering,
	type Facts,
	labOptions,
	oracleCase
} from "#test/pg/catalog/support.ts"
import { assert } from "#test/support/assert.ts"
import type {
	AuthoredExprDesc as ExprDesc,
	HeadTermDesc,
	QueryDesc
} from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import { valueClasses } from "#test/support/oracle/gen/domain.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import { type GenSchema, schemaDesc } from "#test/support/oracle/gen/schema.ts"
import {
	CurrentPerturbation,
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
	conservative,
	defaultRunOptions,
	type LabelledCase,
	type Lowering,
	printOutcome,
	reference,
	type RunOptions,
	runLabelledOracle
} from "#test/support/oracle/runner.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import * as D from "#test/unit/check/dsl.ts"

/**
 * The aggregate order arm: every sum and mean is a function of its arguments' multiset (scalar/aggregate.ts), whatever
 * the order the rows are stored and scanned in, the plan, a parallel worker's partial aggregate, a window frame or a
 * second aggregate in the same head.
 *
 * Each case draws a ledger of up to forty entries over three groups, each a double precision, a real and a money amount
 * from the classes whose IEEE sums depend on their order (gen/domain.ts edge classes: 0.1, 0.2, 0.3, ±1e20 beside 1,
 * ±DBL_MAX, subnormals, money at and a few steps from its int8 bounds), stored in the drawn order, and a perturbation:
 * the planner settings and fact copies of perturb.ts, or every plan forced parallel. The reference states each exact
 * sum once, with no order in it, and every lowering must deliver it exactly (compare.ts, canonical cells): the
 * conservative lowering of each grouped sum and mean, alone and all in one head, and the catalog's window for R41's
 * running total over double precision scores of the same classes.
 *
 * The situations are computed here from the drawn values, never by the system under test: two sequential IEEE sums of
 * a group, forward and backward, that differ; a money or double total that one of those orders overflows and the
 * exact total does not.
 */
type OrderSituation =
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
const ledgerQueries: ReadonlyArray<readonly [string, QueryDesc]> = [
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

const ledgerCase = (
	label: string,
	desc: QueryDesc,
	entries: ReadonlyArray<Entry>
): LabelledCase => {
	const checked = checkQuery(checking(schemaDesc(ledger)), desc, checkOptions("query"))
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

const differ = (a: number, b: number): boolean => !Object.is(canonicalZero(a), canonicalZero(b))

/** A double precision step: IEEE binary64 addition rounds every step already. */
const inDouble = (y: number): number => y

/** The exact sum of finite doubles, rounded once to the nearest double. */
const roundedTotal = (xs: Arr.NonEmptyReadonlyArray<number>): number => {
	const total = Arr.reduce(
		Arr.tailNonEmpty(xs),
		exactDouble(Arr.headNonEmpty(xs)),
		(t: Decimal, x): Decimal => {
			const sum = N.add(t, exactDouble(x))
			if (!sum.ok) {
				throw new Error(`no exact sum: ${sum.error}`)
			}
			return sum.value
		}
	)
	return Number(total.text)
}

const int64 = { lo: -(2n ** 63n), hi: 2n ** 63n - 1n }

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
const situationsOf = (c: AccumulationCase): ReadonlyArray<OrderSituation> => {
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

const runs = 12

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
 * The case a witness runs, aimed at what no witness has reached yet (Case.steering), each pending situation in half
 * its cases by a draw of its own: its plans forced parallel, and its third group drawn from overflowingGroups in place
 * of its own; a rotating or kept case runs as drawn. The situations are computed from the aimed case, so a note never
 * claims what the case does not hold.
 */
const aimed = (k: AccumulationCase, c: Case<OrderSituation>): AccumulationCase =>
	Option.match(c.steering, {
		onNone: () => k,
		onSome: (pending) => ({
			...k,
			entries:
				pending.has("float sum overflowing in some order but not in total") && c.draw(boolean)
					? [
							...Arr.filter(k.entries, (x) => x.grp !== 3),
							...Arr.map(c.draw(element(overflowingGroups)), (x) => plainEntry(3, x, 0n))
						]
					: k.entries,
			perturbation:
				pending.has("aggregate under forced parallel plans") && c.draw(boolean)
					? forcedParallel
					: k.perturbation
		})
	})

const double = (x: number): TypedLiteral => ({ kind: "float", value: canonicalZero(x) })

const plainEntry = (grp: number, x: number, cents: bigint): Entry => ({
	grp,
	x: double(x),
	r: double(Math.fround(x)),
	cents
})

/**
 * The issue's aggregation cases, kept: r.sum and r.mean over {1e20, 1, -1e20, 0.1, 0.2, 0.3}, stored in that order and
 * in reverse, which deliver 1.6 and 0.26666666666666666 from every side; and r.sum over money {92233720368547758.07,
 * 0.01, -0.01}, which delivers 92233720368547758.07 and never 22003, under forced parallel plans.
 */
const kept: ReadonlyArray<Kept<AccumulationCase, OrderSituation>> = [
	{
		note: "a double sum whose IEEE orders disagree, in storage order",
		sketch: {
			entries: Arr.map([1e20, 1, -1e20, 0.1, 0.2, 0.3], (x) => plainEntry(1, x, 0n)),
			sittings: Arr.map([1e20, 1, -1e20, 0.1, 0.2, 0.3], (x, k): Sitting => [k + 1, 1, k + 1, x]),
			perturbation: unperturbed
		},
		draws: "",
		reaches: ["float sum whose IEEE orders disagree", "float mean whose IEEE orders disagree"]
	},
	{
		note: "the same group stored in reverse, its plans forced parallel",
		sketch: {
			entries: Arr.map([0.3, 0.2, 0.1, -1e20, 1, 1e20], (x) => plainEntry(1, x, 0n)),
			sittings: Arr.map([0.3, 0.2, 0.1, -1e20, 1, 1e20], (x, k): Sitting => [k + 1, 1, k + 1, x]),
			perturbation: forcedParallel
		},
		draws: "",
		reaches: [
			"float sum whose IEEE orders disagree",
			"float mean whose IEEE orders disagree",
			"aggregate under forced parallel plans"
		]
	},
	{
		note: "money at its upper bound, a cent past it and back",
		sketch: {
			entries: Arr.map([2n ** 63n - 1n, 1n, -1n], (cents) => plainEntry(1, 0, cents)),
			sittings: [[1, 1, 1, 0]],
			perturbation: unperturbed
		},
		draws: "",
		reaches: ["money sum overflowing in some order but not in total"]
	}
]

layer(Substrate.layer)("aggregates against the exact reference on PostgreSQL 19", (it) => {
	it.effect(
		"delivers every float and money sum and mean as the exact reference states it, in any order and plan",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema({ create: false, label: "accumulation" })
					const options: RunOptions = {
						...defaultRunOptions,
						schema: { kind: "named", name: schema }
					}
					const judged = (label: string, lowered: LabelledCase, side: Lowering, p: Perturbation) =>
						Effect.gen(function* () {
							const outcome = yield* runLabelledOracle(lowered, side, reference, options)
							assert.equal(
								outcome.comparison.equal,
								true,
								`${label}\n${printOutcome(outcome)}\n${printPerturbation(p)}`
							)
						})
					return yield* explore(
						{
							oracle: { kind: "unstated" },
							suite: "pg/compute/accumulation",
							draw: drawn(caseGen),
							literal: Formatter.format,
							coverage: required<OrderSituation>(
								[
									"float sum whose IEEE orders disagree",
									"float mean whose IEEE orders disagree",
									"money sum overflowing in some order but not in total",
									"float sum overflowing in some order but not in total",
									"aggregate under forced parallel plans"
								],
								{ cases: runs, sense: notesOnly }
							),
							kept,
							runs,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(drawnCase, c) => {
							const k = aimed(drawnCase, c)
							return Effect.gen(function* () {
								c.noteAll(situationsOf(k))
								for (const [label, desc] of ledgerQueries) {
									yield* judged(
										label,
										ledgerCase(label, desc, k.entries),
										conservative,
										k.perturbation
									)
								}
								const side = catalogLowering(labOptions)
								const facts: Facts = { sittings: k.sittings, prices: [], points: [] }
								yield* judged(
									"R41 running total",
									oracleCase("R41 running total", Q.running(Q.plainSelfMatch), facts),
									side,
									k.perturbation
								)
								assert.ok(
									appliedRules(side.last()).includes("R41"),
									"R41 rewrote the running total"
								)
							}).pipe(Effect.provideService(CurrentPerturbation, k.perturbation))
						}
					)
				})
			)
	)
})
