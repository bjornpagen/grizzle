/** What the properties of aggregate.test.ts read: its spaces, models and helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Result, String as Str } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { int8Digits, integerDigits } from "#compiler/ir/carriers.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { type AggregateOverload, aggregateOverload } from "#compiler/scalar/aggregate.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import { catalogTypeName } from "#compiler/scalar/compute/registry.ts"
import { exactNumericBound, valueType } from "#compiler/scalar/compute/types.ts"
import { concreteTypeName, textCell } from "#test/pg/compute/support.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { field, testContract, type TestField, testPg } from "#test/unit/compute/support.ts"

interface Sample {
	readonly label: string
	readonly type: ScalarType
	/** The VALUES list of the sample, given the test's schema. */
	readonly values: (schema: string) => string
	/**
	 * The aggregates the host refuses over the sample whatever PostgreSQL defines over its storage: a closed id and a set
	 * of handles are no numbers, so the sum and the mean of a code's smallint, which PostgreSQL computes, are no aggregate
	 * of the handles it stores.
	 */
	readonly noNumber: ReadonlyArray<"sum" | "mean">
}

const mood = field({ kind: "closedId", roster: "Mood", only: undefined }, "code")

const moods = field({ kind: "bits", roster: "Mood" }, "bits")

const Cents = testContract("Cents", testPg.bigint, (x) => Compute.ge(x, 0n))

const plain = (label: string, f: TestField, values: string): Sample => ({
	label,
	type: f.scalar,
	values: () => values,
	noNumber: []
})

const samples: readonly [Sample, ...ReadonlyArray<Sample>] = [
	plain("int2", testPg.smallint, "(VALUES (1::smallint), (2::smallint))"),
	plain("int4", testPg.integer, "(VALUES (1::integer), (2::integer))"),
	plain("int8", testPg.bigint, "(VALUES (1::bigint), (2::bigint))"),
	plain("numeric", testPg.numeric, "(VALUES (1.5::numeric(1000, 20)), (2::numeric(1000, 20)))"),
	plain("float4", testPg.real, "(VALUES (1.5::real), (2::real))"),
	plain("float8", testPg.double, "(VALUES (1.5::double precision), (2::double precision))"),
	plain("money", testPg.money, "(VALUES (1.5::numeric::money), (2::numeric::money))"),
	plain("bool", testPg.boolean, "(VALUES (true), (false))"),
	plain("uuid", testPg.uuid, "(VALUES ('00000000-0000-0000-0000-000000000001'::uuid))"),
	plain("text", testPg.text, "(VALUES ('a'::text), ('b'::text))"),
	{
		label: "range4",
		type: scalarOf(
			{ kind: "span", endpoint: { kind: "pg", type: "integer" }, width: undefined },
			{}
		),
		values: () => "(VALUES (int4range(1, 3)))",
		noNumber: []
	},
	{
		label: "code",
		type: mood.scalar,
		values: (s) => `(VALUES (1::smallint::"${s}".mood), (2::smallint::"${s}".mood))`,
		noNumber: ["sum", "mean"]
	},
	{
		label: "bits",
		type: moods.scalar,
		values: () => "(VALUES ('101'::bit(3)), ('011'::bit(3)))",
		noNumber: ["sum", "mean"]
	},
	{
		label: "Cents",
		type: Cents.scalar,
		values: (s) => `(VALUES (1::"${s}".cents), (2::"${s}".cents))`,
		noNumber: []
	}
]

/**
 * The result type the selected pg_proc row declares: the overload's result carrier, a closed id's a smallint, its
 * code.
 */
const catalogResult = (result: ScalarType): string => catalogTypeName[baseOf(result).carrier]

/**
 * The call whose result PostgreSQL types as the host types the overload's, over the argument `x`: the native call; for
 * a money sum, which is exact money (scalar/aggregate.ts exactSum), the sum over the amounts cast to numeric, whose
 * total no row count overflows; and for a sum over smallint or integer (scalar/aggregate.ts widened), the sum over its
 * values cast to bigint.
 */
const resultCall = (
	o: AggregateOverload,
	x: string
): { readonly sql: string; readonly op: string } => {
	if (o.lowering.kind === "exactSum" && o.lowering.exact === "money") {
		return { sql: `${o.sql}(${x}::numeric)`, op: `${o.sql}(numeric)` }
	}
	return o.lowering.kind === "widened"
		? { sql: `${o.sql}(${x}::bigint)`, op: `${o.sql}(bigint)` }
		: { sql: `${o.sql}(${x})`, op: o.op }
}

/** The integer transition types, by the name pg_aggregate's aggtranstype::regtype gives each, and their digits. */
const integerAccumulators: ReadonlyMap<string, number> = new Map([
	["smallint", integerDigits.int2],
	["integer", integerDigits.int4],
	["bigint", integerDigits.int8]
])

/**
 * Why a sum's emitted aggregate `op` may total its rows to a wrong value: its transition type is an integer of fewer
 * digits than the argument's widened by the rows'. None for a mean, a min or a max, or a sum accumulating otherwise.
 */
const accumulatorProblem = (
	db: RawSession,
	label: string,
	arg: ScalarType,
	op: string
): Effect.Effect<ReadonlyArray<string>, SqlError> =>
	Effect.gen(function* () {
		const [row] = yield* db.values(
			"SELECT a.aggtranstype::regtype::text FROM pg_catalog.pg_aggregate a WHERE a.aggfnoid = to_regprocedure($1::text)",
			[op]
		)
		if (row === undefined) {
			return [`${label}: no pg_aggregate ${op}`]
		}
		const accumulator = textCell(row, 0)
		const digits = integerAccumulators.get(accumulator)
		const argDigits = exactNumericBound(arg)?.digits
		if (digits === undefined) {
			return []
		}
		if (argDigits === undefined) {
			return [`${label}: ${op} accumulates in ${accumulator} over an argument of no digit bound`]
		}
		const needed = argDigits + int8Digits
		return digits >= needed
			? []
			: [
					`${label}: ${op} accumulates in ${accumulator}, of ${digits} digits, where its rows total up to ${needed}`
				]
	})

/**
 * What PostgreSQL says against the host's typing of one aggregate over one sample: an aggregate over no number
 * (`noNumber`) is refused, and PostgreSQL is not asked; any other aggregate the host refuses has no PostgreSQL
 * counterpart, and an admitted one runs, resolves to the pg_aggregate the overload names, takes the sample's
 * base type (or the polymorphic type it instantiates), and its result call (resultCall) has the pg_proc result and the
 * pg_typeof of the host's result type, over the base for a contract. `checked` marks an admitted aggregate whose checks
 * all ran.
 */
export const aggregateProblems = (
	db: RawSession,
	s: string,
	sample: Sample,
	name: "sum" | "mean" | "min" | "max"
): Effect.Effect<
	{ readonly problems: ReadonlyArray<string>; readonly checked: boolean },
	SqlError
> =>
	Effect.gen(function* () {
		const values = sample.values(s)
		const label = `${name}/${sample.label}`
		const overload = aggregateOverload({ name, arg: sample.type }, SourceLoc("test", []))
		const noNumber = Arr.some(sample.noNumber, (n) => n === name)
		if (noNumber) {
			return {
				problems: overload.ok ? [`${label}: admitted, though ${sample.label} is no number`] : [],
				checked: false
			}
		}
		if (!overload.ok) {
			const fn = name === "mean" ? "avg" : name
			const run = yield* db
				.values(`SELECT pg_typeof(${fn}(t.x))::text FROM ${values} AS t(x)`, [])
				.pipe(Effect.result)
			return {
				problems: Result.isSuccess(run) ? [`${label}: refused, but PostgreSQL has ${fn}`] : [],
				checked: false
			}
		}
		const o = overload.value
		const typed = resultCall(o, "t.x")
		const run = yield* db
			.values(`SELECT pg_typeof(${typed.sql})::text FROM ${values} AS t(x)`, [])
			.pipe(Effect.result)
		if (Result.isFailure(run)) {
			return { problems: [`${label}: PostgreSQL has no ${o.sql} over the sample`], checked: false }
		}
		const [typeofRow] = run.success
		const resolved = yield* db.values(
			`SELECT p.oid::regprocedure::text, p.prorettype::regtype::text, p.proargtypes[0]::regtype::text
			FROM pg_catalog.pg_aggregate a JOIN pg_catalog.pg_proc p ON p.oid = a.aggfnoid
			WHERE a.aggfnoid = to_regprocedure($1::text)`,
			[o.op]
		)
		const [resolvedRow] = resolved
		const [resultRow] = yield* db.values(
			"SELECT p.prorettype::regtype::text FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure($1::text)",
			[typed.op]
		)
		if (
			resolved.length !== 1 ||
			resolvedRow === undefined ||
			typeofRow === undefined ||
			resultRow === undefined
		) {
			return { problems: [`${label}: no pg_aggregate ${o.op} or ${typed.op}`], checked: false }
		}
		const [opText, argtype] = [textCell(resolvedRow, 0), textCell(resolvedRow, 2)]
		const accumulated =
			name === "sum" ? yield* accumulatorProblem(db, label, valueType(sample.type), typed.op) : []
		const rettype = textCell(resultRow, 0)
		const [sampleRow] = yield* db.values(
			`SELECT (CASE WHEN ty.typtype = 'd' THEN ty.typbasetype ELSE ty.oid END)::regtype::text, ty.typtype::text
			FROM pg_catalog.pg_type ty, ${values} AS t(x) WHERE ty.oid = pg_typeof(t.x) LIMIT 1`,
			[]
		)
		const [argBase, typtype] =
			sampleRow === undefined ? [] : [textCell(sampleRow, 0), textCell(sampleRow, 1)]
		const polymorphic = argtype === "anyarray" && typtype === "b"
		const arg = valueType(sample.type).carrier
		const expected = concreteTypeName[baseOf(o.result).carrier]
		const typeofResult = textCell(typeofRow, 0)
		return {
			problems: [
				...(opText === o.op ? [] : [`${label}: resolves ${opText}, not ${o.op}`]),
				...(Str.startsWith(`${o.sql}(`)(o.op)
					? []
					: [`${label}: runs ${o.sql}, but names ${o.op}`]),
				...(rettype === catalogResult(o.result)
					? []
					: [
							`${label}: pg_proc ${typed.op} returns ${rettype}, the overload implies ${catalogResult(o.result)}`
						]),
				...(argtype === argBase || polymorphic
					? []
					: [`${label}: pg_proc takes ${argtype}, the sample is ${argBase}`]),
				...(catalogTypeName[arg] === argtype
					? []
					: [`${label}: the overload's argument ${arg} is not pg_proc's ${argtype}`]),
				...(typeofResult === expected
					? []
					: [`${label}: pg_typeof ${typeofResult}, host ${expected}`]),
				...accumulated
			],
			checked: true
		}
	})

/** The aggregates whose typing is checked over every sample. */
const aggregates = ["sum", "mean", "min", "max"] as const

type Aggregate = (typeof aggregates)[number]

/** A call the suite checks: count(*), or an aggregate over a sample. */
type Call =
	| { readonly kind: "count" }
	| { readonly kind: "over"; readonly sample: Sample; readonly name: Aggregate }

export const callGen: Gen<Call> = (source) =>
	source.draw(element(["count", "over"] as const)) === "count"
		? { kind: "count" }
		: {
				kind: "over",
				sample: source.draw(element(samples)),
				name: source.draw(element(aggregates))
			}

/** An admitted aggregate over a sample whose checks all ran, by its name and the sample's label; count(*) checked. */
export type AggregateFeature = `checked ${Aggregate}/${string}` | "checked count(*)"

/**
 * The contract an aggregate's result keeps: an extreme is one of its arguments, so min and max keep the argument's
 * contract; a sum or a mean is no argument, so it keeps none.
 */
export const keptContract = (name: Aggregate, arg: ScalarType): string | undefined =>
	name === "min" || name === "max" ? arg.contract?.name : undefined
