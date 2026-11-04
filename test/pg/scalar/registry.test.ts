import { layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { array, element, int } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, pipe, Result, String as Str } from "effect"
import { type Capability, type Carrier, carriers } from "#compiler/ir/scalar.ts"
import { pgDescriptors } from "#compiler/scalar/pg.ts"
import { type Described, nativeCapabilities } from "#compiler/scalar/registry.ts"
import { uuidDescriptor } from "#compiler/scalar/uuid.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { assert, contains, defined } from "#test/support/assert.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

import { regex } from "arkregex"
/**
 * The catalog type of each carrier; enum is probed through a fresh enum type, ranges through int4range and int8range,
 * and the exact carriers through numeric, the type an exact value of any digit bound is.
 */
const carrierTypes = (
	vectorSchema: string,
	enumType: string
): Readonly<Record<Carrier, string>> => ({
	int2: "int2",
	int4: "int4",
	int8: "int8",
	numeric: "numeric",
	float4: "float4",
	float8: "float8",
	money: "money",
	bool: "bool",
	uuid: "uuid",
	text: "text",
	enum: enumType,
	range4: "int4range",
	range8: "int8range",
	vector: `${vectorSchema}.vector`,
	exactInteger: "numeric",
	exactMoney: "numeric"
})

/** The polymorphic input type PostgreSQL resolves an operator class or aggregate over, for the generic carriers. */
const polymorphic: Partial<Record<Carrier, string>> = {
	enum: "anyenum",
	range4: "anyrange",
	range8: "anyrange"
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
	/** An exact value is never a field's, so no key or constraint indexes it by GiST. */
	exactInteger: ["gist"],
	/** Nor exact money's; a mean over money is no aggregate of the language, as money's own avg is not. */
	exactMoney: ["avg", "gist"]
}

/** The capabilities the registry claims for a carrier. */
const claimedBy = (carrier: Carrier): ReadonlyArray<Capability> => nativeCapabilities[carrier]

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
					Arr.map(inputs, (i) => JSON.stringify(i)),
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
					Arr.map(spellings, (s) => JSON.stringify(s)),
					","
				)}}`
			]
		),
		(rows) => Arr.map(rows, (r) => String(r[0]))
	)

const accepts = (f: () => unknown): boolean => Result.isSuccess(Result.try(f))

/** Every alias spelling of a type the language names, with its descriptor. */
const aliasSpellings: Arr.NonEmptyReadonlyArray<readonly [string, Described]> = [
	["smallint", pgDescriptors.smallint],
	["int2", pgDescriptors.int2],
	["integer", pgDescriptors.integer],
	["int", pgDescriptors.int],
	["int4", pgDescriptors.int4],
	["bigint", pgDescriptors.bigint],
	["int8", pgDescriptors.int8],
	["numeric", pgDescriptors.numeric],
	["decimal", pgDescriptors.decimal],
	["real", pgDescriptors.real],
	["float4", pgDescriptors.float4],
	["double precision", pgDescriptors["double precision"]],
	["float8", pgDescriptors.float8],
	["float", pgDescriptors.float],
	["money", pgDescriptors.money],
	["boolean", pgDescriptors.boolean],
	["bool", pgDescriptors.bool],
	["uuid", uuidDescriptor]
]

/** The edges of numeric's precision and scale, each paired with every other. */
const numericEdges = [-1001, -1000, -999, -1, 0, 1, 2, 999, 1000, 1001]
const edgePairs: ReadonlyArray<readonly [number, number]> = Arr.flatMap(numericEdges, (p) =>
	Arr.map(numericEdges, (sc) => [p, sc] as const)
)

/** The edges of pgvector's dimensions. */
const vectorDims: Arr.NonEmptyReadonlyArray<number> = [
	-1, 0, 1, 2, 1536, 2000, 2001, 15999, 16000, 16001, 100000
]

layer(Substrate.layer)("descriptors against the PostgreSQL 19 catalog", (it) => {
	it.effect("names one PostgreSQL type with every alias spelling", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { session } = yield* Substrate
				const db = yield* session(ownerSession())
				yield* installProbe(db)
				const exhausted = yield* exhaust(
					{
						suite: "pg/scalar/registry/spellings",
						generator: element(aliasSpellings),
						literal: ([spelling]: readonly [string, Described]) => Formatter.format(spelling),
						limit: aliasSpellings.length,
						coverage: noCoverage,
						caseHang: Duration.minutes(2)
					},
					([spelling, field]) =>
						Effect.map(probe(db, [spelling]), (stored) => {
							assert.deepEqual(stored, [field.sql], spelling)
						})
				)
				/** The serial names are PostgreSQL's serial pseudo-types over these integers. */
				const serials = yield* probe(db, [
					"smallserial",
					"serial2",
					"serial",
					"serial4",
					"bigserial",
					"serial8"
				])
				assert.deepEqual(serials, [
					pgDescriptors.smallserial.sql,
					pgDescriptors.serial2.sql,
					pgDescriptors.serial.sql,
					pgDescriptors.serial4.sql,
					pgDescriptors.bigserial.sql,
					pgDescriptors.serial8.sql
				])
				return exhausted
			})
		)
	)

	it.effect(
		"selects real or double precision for float(p) as PostgreSQL does, and refuses what it refuses",
		() =>
			Effect.gen(function* () {
				const { session } = yield* Substrate
				const db = yield* session(ownerSession())
				yield* installProbe(db)
				const ps = Arr.makeBy(64, (i) => i - 4)
				const stored = yield* probe(
					db,
					Arr.map(ps, (p) => `float(${p})`)
				)
				for (const [i, p] of ps.entries()) {
					const pgAccepts = !pipe(storedAt(stored, i), Str.startsWith("refused"))
					assert.equal(
						accepts(() => pgDescriptors.float(p)),
						pgAccepts,
						`float(${p})`
					)
					if (pgAccepts) {
						assert.equal(storedAt(stored, i), pgDescriptors.float(p).sql, `float(${p})`)
					}
				}
			})
	)

	it.effect("accepts exactly the numeric typmods numerictypmodin accepts", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { session } = yield* Substrate
				const db = yield* session(ownerSession())
				yield* installProbe(db)
				const explored = yield* explore(
					{
						suite: "pg/scalar/registry/numeric-typmods",
						draw: drawn(
							array(
								(source) => [source.draw(int(-5, 1010)), source.draw(int(-1010, 1010))] as const,
								{ min: 1, max: 400 }
							)
						),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 2,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					(drawnPairs) =>
						Effect.gen(function* () {
							const pairs = [...edgePairs, ...drawnPairs]
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
								if (pgAccepts) {
									assert.equal(stored[i], `numeric(${p},${s})`)
								}
							}
						})
				)
				/** numeric(p) is numeric(p, 0). */
				const bare = yield* probe(db, ["numeric(5)", "decimal(5)", "numeric(1000)"])
				assert.deepEqual(bare, ["numeric(5,0)", "numeric(5,0)", "numeric(1000,0)"])
				assert.equal(pgDescriptors.numeric(5).scale, 0)
				return explored
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
						generator: element(vectorDims),
						literal: Formatter.format,
						limit: vectorDims.length,
						coverage: noCoverage,
						caseHang: Duration.minutes(2)
					},
					(n) =>
						Effect.map(probe(db, [`${vectorSchema}.vector(${n})`]), (stored) => {
							const pgAccepts = !pipe(storedAt(stored, 0), Str.startsWith("refused"))
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

	it.effect("claims only native capabilities, and leaves out only the documented exclusions", () =>
		Effect.gen(function* () {
			const { session } = yield* Substrate
			const db = yield* session(ownerSession())
			yield* db.query("CREATE EXTENSION IF NOT EXISTS btree_gist", [])
			const vectorSchema = yield* vectorSchemaOf(db)
			yield* db.query("CREATE TYPE pg_temp.probe_enum AS ENUM ('a', 'b')", [])
			const types = carrierTypes(vectorSchema, "pg_temp.probe_enum")
			for (const carrier of carriers) {
				const native = yield* nativeOf(db, types[carrier], polymorphic[carrier])
				const claimed = Arr.filter(claimedBy(carrier), (c) => catalogNames.includes(c))
				const excluded = exclusions[carrier] ?? []
				assert.deepEqual(
					claimed,
					Arr.filter(native, (c) => !excluded.includes(c)),
					carrier
				)
				for (const c of excluded) {
					contains(native, c, `${carrier} excludes a native ${c}`)
				}
				if (claimedBy(carrier).includes("expressionIndex")) {
					contains(native, "ordering", `${carrier} expression index`)
				}
			}
		})
	)

	it.effect(
		"has span endpoints exactly where a built-in discrete range exists over the carrier",
		() =>
			Effect.gen(function* () {
				const { session } = yield* Substrate
				const db = yield* session(ownerSession())
				const vectorSchema = yield* vectorSchemaOf(db)
				yield* db.query("CREATE TYPE pg_temp.probe_enum AS ENUM ('a', 'b')", [])
				const types = carrierTypes(vectorSchema, "pg_temp.probe_enum")
				/**
				 * A carrier is a span endpoint exactly where PostgreSQL has a built-in range over its type with a canonical
				 * function, so that a span's text is canonical: a discrete range.
				 */
				const discrete: Array<Carrier> = []
				for (const carrier of carriers) {
					const [row] = yield* db.values(
						"SELECT EXISTS (SELECT FROM pg_catalog.pg_range r WHERE r.rngsubtype = $1::text::regtype AND r.rngcanonical <> 0)::text",
						[types[carrier]]
					)
					if (defined(row, carrier)[0] === "true") {
						discrete.push(carrier)
					}
				}
				assert.notDeepEqual(discrete, [], "a discrete range")
				assert.deepEqual(
					Arr.filter(carriers, (c) => claimedBy(c).includes("spanEndpoint")),
					discrete
				)
			})
	)
})
