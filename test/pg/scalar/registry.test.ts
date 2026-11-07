import { layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, element, type Gen, int, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, pipe, Result, String as Str } from "effect"
import { vectorMaxDimensions } from "#compiler/ir/carriers.ts"
import {
	type Capability,
	type Carrier,
	carriers,
	numericMaxPrecision,
	numericMaxScale,
	numericMinScale
} from "#compiler/ir/scalar.ts"
import { floatOf, pgDescriptors } from "#compiler/scalar/pg.ts"
import { nativeCapabilities } from "#compiler/scalar/registry.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { assert, contains, defined } from "#test/support/assert.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

import { regex } from "arkregex"
import { jsonText } from "#compiler/core/trusted.ts"
import { caseHang } from "#test/support/limits.ts"
import { isSerial, spelled, spellings } from "#test/unit/scalar/support.ts"
/**
 * The catalog type of each carrier; a closed id is probed through smallint, the type of its code under its roster's
 * domain, a set through bit, ranges through int4range and int8range, and the exact carriers through numeric, the type
 * an exact value of any digit bound is.
 */
const carrierTypes = (vectorSchema: string): Readonly<Record<Carrier, string>> => ({
	int2: "int2",
	int4: "int4",
	int8: "int8",
	numeric: "numeric",
	float4: "float4",
	float8: "float8",
	money: "money",
	bool: "bool",
	uuid: "uuid",
	date: "date",
	text: "text",
	bytes: "bytea",
	code: "int2",
	bits: "bit",
	range4: "int4range",
	range8: "int8range",
	rangeDate: "daterange",
	vector: `${vectorSchema}.vector`,
	exactInteger: "numeric",
	exactMoney: "numeric"
})

/** The polymorphic input type PostgreSQL resolves an operator class or aggregate over, for the generic carriers. */
const polymorphic: Partial<Record<Carrier, string>> = {
	range4: "anyrange",
	range8: "anyrange",
	rangeDate: "anyrange"
}

/**
 * The capabilities test/pg/scalar checks against the catalog. spanEndpoint, storage, expressionIndex and
 * vectorDistance are checked separately below.
 */
const catalogCapabilities = [
	"avg",
	"boolAgg",
	"equality",
	"gist",
	"hashing",
	"minMax",
	"ordering",
	"sum"
] as const
const catalogNames: ReadonlyArray<string> = catalogCapabilities

/** Native capabilities the language does not admit, each with its reason. Nothing else may differ from the catalog. */
const exclusions: Partial<Record<Carrier, ReadonlyArray<(typeof catalogCapabilities)[number]>>> = {
	/**
	 * pgvector's sum(vector) and avg(vector) are not aggregates of the language (its aggregate vocabulary is count, sum,
	 * mean, min and max over the scalar carriers that admit them).
	 */
	vector: ["avg", "sum"],
	/** A closed id's code numbers its handle, never a quantity: no sum or mean over codes. */
	code: ["avg", "sum"],
	/**
	 * A set's bit string orders lexicographically, which orders no sets, and the language indexes a set by equality
	 * alone, never by GiST.
	 */
	bits: ["gist", "ordering"],
	/** An exact value is never a field's, so no key or constraint indexes it by GiST. */
	exactInteger: ["gist"],
	/** Nor exact money's; a mean over money is no aggregate of the language, as money's own avg is not. */
	exactMoney: ["avg", "gist"]
}

/** The capabilities the registry claims for a carrier. */
const claimedBy = (carrier: Carrier): ReadonlyArray<Capability> => nativeCapabilities[carrier]

/**
 * The carriers PostgreSQL has a discrete range over that grizzle declares no span over, each with the README's named
 * limit (Limits, "A span is over integer or bigint"). Nothing else may differ from the catalog.
 */
const unspanned: Partial<Record<Carrier, string>> = {
	date: "daterange: grizzle declares no span carrier over a date yet"
}

/** What a precision of float(p) reached: PostgreSQL's refusal on either side, or the type it stores. */
type FloatFeature = "refused below" | "real" | "double precision" | "refused above"

/** What a carrier reached: an excluded native capability, and its span endpoints against the discrete ranges. */
type CarrierFeature =
	| "a native capability excluded"
	| "a spannable carrier"
	| "a discrete range named as a limit"
	| "no discrete range"

/** The text a probe stored for spelling i: every spelling has one. */
const storedAt = (stored: ReadonlyArray<string>, i: number): string => {
	const s = stored[i]
	if (s === undefined) {
		throw new Error(`no stored type for spelling ${i}`)
	}
	return s
}

const vectorSchemaOf = (db: RawSession) =>
	Effect.map(
		db.values(
			"SELECT n.nspname::text FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'",
			[]
		),
		(rows) => quoteIdent(String(rows[0]?.[0]))
	)

/** What the catalog offers on one type, over the capability vocabulary. */
const nativeOf = (db: RawSession, type: string, poly: string | undefined) =>
	Effect.gen(function* () {
		const inputs = poly === undefined ? [type] : [type, poly]
		const rows = yield* db.values(
			`WITH t(oid) AS (SELECT unnest($1::text[])::regtype::oid)
			SELECT
				EXISTS (SELECT FROM pg_catalog.pg_operator o WHERE o.oprname = '=' AND o.oprleft IN (SELECT oid FROM t)
					AND o.oprright IN (SELECT oid FROM t) AND o.oprresult = 'bool'::regtype)::text,
				EXISTS (SELECT FROM pg_catalog.pg_opclass c JOIN pg_catalog.pg_am a ON a.oid = c.opcmethod
					WHERE c.opcdefault AND a.amname = 'btree' AND c.opcintype IN (SELECT oid FROM t))::text,
				EXISTS (SELECT FROM pg_catalog.pg_opclass c JOIN pg_catalog.pg_am a ON a.oid = c.opcmethod
					WHERE c.opcdefault AND a.amname = 'hash' AND c.opcintype IN (SELECT oid FROM t))::text,
				EXISTS (SELECT FROM pg_catalog.pg_opclass c JOIN pg_catalog.pg_am a ON a.oid = c.opcmethod
					WHERE c.opcdefault AND a.amname = 'gist' AND c.opcintype IN (SELECT oid FROM t))::text,
				EXISTS (SELECT FROM pg_catalog.pg_aggregate g JOIN pg_catalog.pg_proc p ON p.oid = g.aggfnoid
					WHERE p.proname = 'sum' AND p.pronargs = 1 AND p.proargtypes[0] IN (SELECT oid FROM t))::text,
				EXISTS (SELECT FROM pg_catalog.pg_aggregate g JOIN pg_catalog.pg_proc p ON p.oid = g.aggfnoid
					WHERE p.proname = 'avg' AND p.pronargs = 1 AND p.proargtypes[0] IN (SELECT oid FROM t))::text,
				(EXISTS (SELECT FROM pg_catalog.pg_aggregate g JOIN pg_catalog.pg_proc p ON p.oid = g.aggfnoid
					WHERE p.proname = 'min' AND p.pronargs = 1 AND p.proargtypes[0] IN (SELECT oid FROM t))
				AND EXISTS (SELECT FROM pg_catalog.pg_aggregate g JOIN pg_catalog.pg_proc p ON p.oid = g.aggfnoid
					WHERE p.proname = 'max' AND p.pronargs = 1 AND p.proargtypes[0] IN (SELECT oid FROM t)))::text,
				(EXISTS (SELECT FROM pg_catalog.pg_aggregate g JOIN pg_catalog.pg_proc p ON p.oid = g.aggfnoid
					WHERE p.proname = 'bool_and' AND p.pronargs = 1 AND p.proargtypes[0] IN (SELECT oid FROM t))
				AND EXISTS (SELECT FROM pg_catalog.pg_aggregate g JOIN pg_catalog.pg_proc p ON p.oid = g.aggfnoid
					WHERE p.proname = 'bool_or' AND p.pronargs = 1 AND p.proargtypes[0] IN (SELECT oid FROM t)))::text`,
			[
				`{${Arr.join(
					Arr.map(inputs, (i) => jsonText(i)),
					","
				)}}`
			]
		)
		const [equality, ordering, hashing, gist, sum, avg, minMax, boolAgg] = Arr.map(
			rows[0] ?? [],
			(v) => v === "true"
		)
		const offered: Record<(typeof catalogCapabilities)[number], boolean | undefined> = {
			equality,
			ordering,
			hashing,
			gist,
			sum,
			avg,
			minMax,
			boolAgg
		}
		return Arr.filter(catalogCapabilities, (c) => offered[c] === true)
	})

/**
 * A probe that creates a temporary column of each type spelling and reports the type PostgreSQL stored, or the
 * SQLSTATE it refused the spelling with.
 */
const installProbe = (db: RawSession) =>
	db.query(
		`CREATE FUNCTION pg_temp.probe_type(spelling text) RETURNS text LANGUAGE plpgsql AS $$
		DECLARE stored text;
		BEGIN
			EXECUTE format('CREATE TEMPORARY TABLE probe_t (v %s)', spelling);
			SELECT format_type(a.atttypid, a.atttypmod) INTO STRICT stored FROM pg_catalog.pg_attribute a
				WHERE a.attrelid = 'probe_t'::regclass AND a.attname = 'v';
			DROP TABLE probe_t;
			RETURN stored;
		EXCEPTION WHEN OTHERS THEN
			RETURN 'refused ' || SQLSTATE;
		END $$`,
		[]
	)

const probe = (db: RawSession, spellings: ReadonlyArray<string>) =>
	Effect.map(
		db.values(
			"SELECT pg_temp.probe_type(s) FROM unnest($1::text[]) WITH ORDINALITY AS u(s, i) ORDER BY u.i",
			[
				`{${Arr.join(
					Arr.map(spellings, (s) => jsonText(s)),
					","
				)}}`
			]
		),
		(rows) => Arr.map(rows, (r) => String(r[0]))
	)

const accepts = (f: () => unknown): boolean => Result.isSuccess(Result.try(f))

/** A precision or a scale near numerictypmodin's bounds, or anywhere past them on either side. */
const nearBounds = (bounds: ReadonlyArray<number>, far: number): Gen<number> =>
	oneOf([int(-far, far), ...Arr.map(bounds, (bound) => int(bound - 2, bound + 2))])

/** A numeric typmod: its precision near 1 and numericMaxPrecision, its scale near 0 and both scale bounds. */
const typmodGen: Gen<readonly [number, number]> = (source) =>
	[
		source.draw(nearBounds([1, numericMaxPrecision.value], numericMaxPrecision.value + 10)),
		source.draw(
			nearBounds([numericMinScale.value, 0, numericMaxScale.value], numericMaxScale.value + 10)
		)
	] as const

/** What a vector dimension count reached: refused below, admitted, refused above. */
type DimensionsFeature = "refused below" | "admitted" | "refused above"

layer(Substrate.layer)("descriptors against the PostgreSQL 19 catalog", (it) => {
	it.effect("names the type PostgreSQL stores with every spelling of the pg namespace", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { session } = yield* Substrate
				const db = yield* session(ownerSession())
				yield* installProbe(db)
				return yield* exhaust(
					{
						suite: "pg/scalar/registry/spellings",
						generator: element(spellings),
						literal: Formatter.format,
						limit: spellings.length,
						box: "every spelling of the pg namespace that is a descriptor, the serials among them",
						oracle: {
							kind: "postgresql",
							name: "the type PostgreSQL stores a column of the spelling as"
						},
						coverage: requiredInSpace<"a serial" | "a type">(["a serial", "a type"]),
						caseHang
					},
					(spelling, c) =>
						Effect.map(probe(db, [spelling]), (stored) => {
							c.note(isSerial(spelling) ? "a serial" : "a type")
							assert.deepEqual(stored, [spelled(spelling).sql], spelling)
						})
				)
			})
		)
	)

	it.effect(
		"selects real or double precision for float(p) as PostgreSQL does, and refuses what it refuses",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { session } = yield* Substrate
					const db = yield* session(ownerSession())
					yield* installProbe(db)
					return yield* exhaust(
						{
							suite: "pg/scalar/registry/float-precisions",
							generator: int(-4, 59),
							literal: (p: number) => `float(${p})`,
							limit: 64,
							box: "every precision from -4 to 59, past both of float(p)'s edges",
							oracle: { kind: "postgresql", name: "the type PostgreSQL stores float(p) as" },
							coverage: requiredInSpace<FloatFeature>([
								"refused below",
								"real",
								"double precision",
								"refused above"
							]),
							caseHang
						},
						(p, c) =>
							Effect.map(probe(db, [`float(${p})`]), (stored) => {
								const pgAccepts = !pipe(storedAt(stored, 0), Str.startsWith("refused"))
								assert.equal(
									accepts(() => floatOf(p)),
									pgAccepts,
									`float(${p})`
								)
								if (pgAccepts) {
									assert.equal(storedAt(stored, 0), floatOf(p).sql, `float(${p})`)
									c.note(storedAt(stored, 0) === "real" ? "real" : "double precision")
								} else {
									c.note(p < 1 ? "refused below" : "refused above")
								}
							})
					)
				})
			)
	)

	it.effect("accepts exactly the numeric typmods numerictypmodin accepts", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { session } = yield* Substrate
				const db = yield* session(ownerSession())
				yield* installProbe(db)
				return yield* explore(
					{
						suite: "pg/scalar/registry/numeric-typmods",
						draw: drawn(array(typmodGen, { min: 1, max: 400 })),
						literal: Formatter.format,
						oracle: { kind: "postgresql", name: "numerictypmodin, through a column's declaration" },
						coverage: required<"admitted" | "refused">(["admitted", "refused"], {
							cases: 2,
							sense: notesOnly
						}),
						kept: [],
						runs: 2,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(pairs, c) =>
						Effect.gen(function* () {
							const stored = yield* probe(
								db,
								Arr.map(pairs, ([p, s]) => `numeric(${p}, ${s})`)
							)
							for (const [i, [p, s]] of pairs.entries()) {
								const pgAccepts = !pipe(storedAt(stored, i), Str.startsWith("refused"))
								assert.equal(
									accepts(() => pgDescriptors.numeric(p, s)),
									pgAccepts,
									`numeric(${p}, ${s})`
								)
								c.note(pgAccepts ? "admitted" : "refused")
								if (pgAccepts) {
									assert.equal(stored[i], `numeric(${p},${s})`)
								}
							}
						})
				)
			})
		)
	)

	it.effect("accepts exactly the vector dimensions pgvector accepts", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { session } = yield* Substrate
				const db = yield* session(ownerSession())
				yield* installProbe(db)
				const vectorSchema = yield* vectorSchemaOf(db)
				return yield* exhaust(
					{
						suite: "pg/scalar/registry/vector-dimensions",
						generator: oneOf([
							int(-2, 3),
							int(vectorMaxDimensions.value - 2, vectorMaxDimensions.value + 2)
						]),
						literal: Formatter.format,
						limit: 11,
						box: "every dimension count within two of 1 and of vectorMaxDimensions, and down to -2",
						oracle: {
							kind: "postgresql",
							name: "pgvector's typmod input, through a column's declaration"
						},
						coverage: requiredInSpace<DimensionsFeature>([
							"refused below",
							"admitted",
							"refused above"
						]),
						caseHang
					},
					(n, c) =>
						Effect.map(probe(db, [`${vectorSchema}.vector(${n})`]), (stored) => {
							const pgAccepts = !pipe(storedAt(stored, 0), Str.startsWith("refused"))
							c.note(pgAccepts ? "admitted" : n < 1 ? "refused below" : "refused above")
							assert.equal(
								accepts(() => pgDescriptors.vector(n)),
								pgAccepts,
								`vector(${n})`
							)
							if (pgAccepts) {
								assert.match(storedAt(stored, 0), regex.as(`vector\\(${n}\\)$`))
							}
						})
				)
			})
		)
	)

	it.effect(
		"claims only native capabilities, leaves out only the documented exclusions, and has span endpoints exactly where a built-in discrete range exists or its limit is named",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { session } = yield* Substrate
					const db = yield* session(ownerSession())
					yield* db.query("CREATE EXTENSION IF NOT EXISTS btree_gist", [])
					const vectorSchema = yield* vectorSchemaOf(db)
					const types = carrierTypes(vectorSchema)
					return yield* exhaust(
						{
							suite: "pg/scalar/registry/carriers",
							generator: element(carriers),
							literal: Formatter.format,
							limit: carriers.length,
							box: "every carrier of the registry",
							oracle: {
								kind: "postgresql",
								name: "the catalog's operators, operator classes, aggregates and discrete ranges over the carrier's type"
							},
							coverage: requiredInSpace<CarrierFeature>([
								"a native capability excluded",
								"a spannable carrier",
								"a discrete range named as a limit",
								"no discrete range"
							]),
							caseHang
						},
						(carrier, c) =>
							Effect.gen(function* () {
								const native = yield* nativeOf(db, types[carrier], polymorphic[carrier])
								const claimed = Arr.filter(claimedBy(carrier), (cap) => catalogNames.includes(cap))
								const excluded = exclusions[carrier] ?? []
								assert.deepEqual(
									claimed,
									Arr.filter(native, (cap) => !excluded.includes(cap)),
									carrier
								)
								for (const cap of excluded) {
									contains(native, cap, `${carrier} excludes a native ${cap}`)
									c.note("a native capability excluded")
								}
								if (claimedBy(carrier).includes("expressionIndex")) {
									contains(native, "ordering", `${carrier} expression index`)
								}
								/**
								 * A carrier may be a span endpoint only where PostgreSQL has a built-in range over its
								 * type with a canonical function, so that a span's text is canonical: a discrete range.
								 * Each carrier with one is a span endpoint or is named in `unspanned` with its limit,
								 * never neither and never both, so a ranged carrier the registry gains is refused here
								 * until it is declared spannable or its limit is stated.
								 */
								const [row] = yield* db.values(
									"SELECT EXISTS (SELECT FROM pg_catalog.pg_range r WHERE r.rngsubtype = $1::text::regtype AND r.rngcanonical <> 0)::text",
									[types[carrier]]
								)
								const discrete = defined(row, carrier)[0] === "true"
								const spannable = claimedBy(carrier).includes("spanEndpoint")
								const limited = unspanned[carrier] !== undefined
								assert.deepEqual(
									{ spannable, limited },
									{ spannable: discrete && !limited, limited: discrete && !spannable },
									`${carrier}: a discrete range is a span endpoint or a named limit, exactly one`
								)
								c.note(
									spannable
										? "a spannable carrier"
										: limited
											? "a discrete range named as a limit"
											: "no discrete range"
								)
							})
					)
				})
			)
	)
})
