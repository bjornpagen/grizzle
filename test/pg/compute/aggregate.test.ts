import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Duration, Effect, Result, String as Str } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { baseOf, contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { aggregateOverload } from "#compiler/scalar/aggregate.ts"
import { catalogTypeName, concreteTypeName } from "#compiler/scalar/compute/registry.ts"
import { valueType } from "#compiler/scalar/compute/types.ts"
import { textCell } from "#test/pg/compute/support.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
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
	 * The concrete type pg_typeof reports for min and max over the sample: the host result's, or, where min and max
	 * return a polymorphic type, the sample's own type, given the schema.
	 */
	readonly minMaxType:
		| { readonly kind: "result" }
		| { readonly kind: "own"; readonly type: (schema: string) => string }
}

const mood = field({ kind: "closedId", roster: "Mood" }, "enum")
const Cents = testContract("Cents", testPg.bigint, (x) => x.ge(0n))

const plain = (label: string, f: TestField, values: string): Sample => ({
	label,
	type: f.scalar,
	values: () => values,
	minMaxType: { kind: "result" }
})

const samples: readonly [Sample, ...ReadonlyArray<Sample>] = [
	plain("int2", testPg.smallint, "(VALUES (1::smallint), (2::smallint))"),
	plain("int4", testPg.integer, "(VALUES (1::integer), (2::integer))"),
	plain("int8", testPg.bigint, "(VALUES (1::bigint), (2::bigint))"),
	plain("numeric", testPg.numeric, "(VALUES (1.5::numeric), (2::numeric))"),
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
		minMaxType: { kind: "result" }
	},
	{
		label: "enum",
		type: mood.scalar,
		values: (s) => `(VALUES ('ok'::"${s}".mood), ('happy'::"${s}".mood))`,
		/** regtype output quotes only names that need it; the test schemas are lowercase. */
		minMaxType: { kind: "own", type: (s) => `${s}.mood` }
	},
	{
		label: "Cents",
		type: Cents.scalar,
		values: (s) => `(VALUES (1::"${s}".cents), (2::"${s}".cents))`,
		minMaxType: { kind: "result" }
	}
]

/**
 * The result type the selected pg_proc row declares: the overload's result carrier, or the polymorphic type a min or
 * max over an enum returns.
 */
const catalogResult = (result: ScalarType): string => catalogTypeName[baseOf(result).carrier]

/**
 * What PostgreSQL says against the host's typing of one aggregate over one sample: an aggregate the host refuses has no
 * PostgreSQL counterpart, and an admitted one runs, resolves to the pg_aggregate the overload names, takes the sample's
 * base type (or the polymorphic type it instantiates), and has pg_typeof the host's result type, over the base for a
 * contract. `checked` marks an admitted aggregate whose checks all ran.
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
		const run = yield* db
			.values(`SELECT pg_typeof(${o.sql}(t.x))::text FROM ${values} AS t(x)`, [])
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
		if (resolved.length !== 1 || resolvedRow === undefined || typeofRow === undefined) {
			return { problems: [`${label}: no pg_aggregate ${o.op}`], checked: false }
		}
		const [opText, rettype, argtype] = [
			textCell(resolvedRow, 0),
			textCell(resolvedRow, 1),
			textCell(resolvedRow, 2)
		]
		const [sampleRow] = yield* db.values(
			`SELECT (CASE WHEN ty.typtype = 'd' THEN ty.typbasetype ELSE ty.oid END)::regtype::text, ty.typtype::text
			FROM pg_catalog.pg_type ty, ${values} AS t(x) WHERE ty.oid = pg_typeof(t.x) LIMIT 1`,
			[]
		)
		const [argBase, typtype] =
			sampleRow === undefined ? [] : [textCell(sampleRow, 0), textCell(sampleRow, 1)]
		const polymorphic =
			(argtype === "anyenum" && typtype === "e") || (argtype === "anyarray" && typtype === "b")
		const arg = valueType(sample.type).carrier
		const expected =
			sample.minMaxType.kind === "own" && (name === "min" || name === "max")
				? sample.minMaxType.type(s)
				: concreteTypeName[baseOf(o.result).carrier]
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
							`${label}: pg_proc returns ${rettype}, the overload implies ${catalogResult(o.result)}`
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
					yield* db.query(`CREATE TYPE "${s}".mood AS ENUM ('sad', 'ok', 'happy')`, [])
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
								"checked min/enum",
								"checked sum/Cents",
								"checked max/Cents",
								"checked min/bool"
							]),
							caseHang: Duration.minutes(2)
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
