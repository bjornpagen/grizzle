import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Result, String as Str } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { baseOf, contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { type AggregateOverload, aggregateOverload } from "#compiler/scalar/aggregate.ts"
import { catalogTypeName } from "#compiler/scalar/compute/registry.ts"
import { valueType } from "#compiler/scalar/compute/types.ts"
import { concreteTypeName, textCell } from "#test/pg/compute/support.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { caseHang } from "#test/support/limits.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { testContract, field, testPg, type TestField } from "#test/unit/compute/support.ts"

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

const mood = field({ kind: "closedId", roster: "Mood" }, "code")
const moods = field({ kind: "bits", roster: "Mood" }, "bits")
const Cents = testContract("Cents", testPg.bigint, (x) => x.ge(0n))

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
 * The call whose result PostgreSQL types as the host types the overload's, over the argument `x`: the native call, or,
 * for a money sum, which is exact money (scalar/aggregate.ts exactSum), the sum over the amounts cast to numeric, whose
 * total no row count overflows.
 */
const resultCall = (
	o: AggregateOverload,
	x: string
): { readonly sql: string; readonly op: string } =>
	o.lowering.kind === "exactSum" && o.lowering.exact === "money"
		? { sql: `${o.sql}(${x}::numeric)`, op: `${o.sql}(numeric)` }
		: { sql: `${o.sql}(${x})`, op: o.op }

/**
 * What PostgreSQL says against the host's typing of one aggregate over one sample: an aggregate over no number
 * (`noNumber`) is refused, and PostgreSQL is not asked; any other aggregate the host refuses has no PostgreSQL
 * counterpart, and an admitted one runs, resolves to the pg_aggregate the overload names, takes the sample's
 * base type (or the polymorphic type it instantiates), and its result call (resultCall) has the pg_proc result and the
 * pg_typeof of the host's result type, over the base for a contract. `checked` marks an admitted aggregate whose checks
 * all ran.
 */
const aggregateProblems = (
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
					: [`${label}: pg_typeof ${typeofResult}, host ${expected}`])
			],
			checked: true
		}
	})

/** The aggregates whose typing is checked over every sample. */
const aggregates = ["sum", "mean", "min", "max"] as const

type Aggregate = (typeof aggregates)[number]

/** An admitted aggregate over a sample whose checks all ran, by its name and the sample's label. */
type AggregateFeature = `checked ${Aggregate}/${string}`

layer(Substrate.layer)("aggregate typing against PostgreSQL 19", (it) => {
	it.effect(
		"types every aggregate as pg_aggregate and pg_typeof do, and refuses what PostgreSQL lacks",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { session, schema } = yield* Substrate
					const db = yield* session(ownerSession())
					const s = yield* schema(freshSchema)
					yield* db.query(
						`CREATE DOMAIN "${s}".mood AS smallint CONSTRAINT mood_check CHECK ((VALUE BETWEEN 0 AND 2) IS TRUE)`,
						[]
					)
					yield* db.query(
						`CREATE DOMAIN "${s}".cents AS bigint CONSTRAINT cents_check CHECK ((VALUE >= 0) IS TRUE)`,
						[]
					)
					return yield* exhaust(
						{
							suite: "pg/compute/aggregate",
							generator: (source) =>
								[source.draw(element(samples)), source.draw(element(aggregates))] as const,
							literal: ([sample, name]) => `${name}/${sample.label}`,
							limit: samples.length * aggregates.length,
							coverage: requiredInSpace<AggregateFeature>([
								"checked min/code",
								"checked sum/Cents",
								"checked max/Cents",
								"checked min/bool"
							]),
							caseHang
						},
						([sample, name], c) =>
							Effect.gen(function* () {
								const outcome = yield* aggregateProblems(db, s, sample, name)
								assert.deepEqual(outcome.problems, [])
								if (outcome.checked) {
									c.note(`checked ${name}/${sample.label}`)
								}
							})
					)
				})
			)
	)

	it.effect("types count(*) and keeps a contract through min but not through sum", () =>
		Effect.gen(function* () {
			const { session } = yield* Substrate
			const db = yield* session(ownerSession())
			const count = succeeded(aggregateOverload({ name: "count" }, SourceLoc("test", [])))
			const [row] = yield* db.values(
				"SELECT pg_typeof(count(*))::text, to_regprocedure('count()')::regprocedure::text FROM (VALUES (1)) AS t(x)",
				[]
			)
			assert.deepEqual(row, [concreteTypeName[count.result.carrier], count.op])
			assert.equal<string | undefined>(
				contractOf(
					succeeded(aggregateOverload({ name: "min", arg: Cents.scalar }, SourceLoc("test", [])))
						.result
				)?.name,
				"Cents"
			)
			assert.equal(
				contractOf(
					succeeded(aggregateOverload({ name: "sum", arg: Cents.scalar }, SourceLoc("test", [])))
						.result
				),
				undefined
			)
		})
	)
})
