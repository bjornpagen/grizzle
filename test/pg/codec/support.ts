import { Array as Arr, Effect } from "effect"
import { resultTextCasts } from "#compiler/codec/scalar.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { type Codebook, codecOf } from "#compiler/ir/codes.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/**
 * Shared helpers for the codec tests against PostgreSQL (test/pg/codec).
 *
 * Rows of PostgreSQL's text output, admitted as what they are: each column its text, or NULL.
 */
export const textRows = (rows: unknown): ReadonlyArray<ReadonlyArray<string>> =>
	trusted<ReadonlyArray<ReadonlyArray<string>>>(rows)

/** A field of a fact, by a name its heading lists. */
export const fieldOf = (fact: Readonly<Record<string, unknown>>, name: string): unknown =>
	fact[name]

/** The pinned pgvector installation's schema, quoted (the extension lives in its own schema). */
export const vectorSchemaOf = (db: RawSession) =>
	Effect.map(
		db.values(
			"SELECT n.nspname::text FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'",
			[]
		),
		(rows) => quoteIdent(String(rows[0]?.[0]))
	)

/**
 * The fixed monetary context every login carries as its defaults; a raw session sets it itself, then runs the
 * numeric money-context check admission runs.
 */
export const monetaryContext = (db: RawSession) =>
	Effect.gen(function* () {
		yield* db.values("SET lc_monetary TO 'C.UTF-8'", [])
		yield* db.values("SET lc_numeric TO 'C.UTF-8'", [])
		const rows = yield* db.values("SELECT ('1.005'::money::numeric = 1.01)::text", [])
		if (rows[0]?.[0] !== "true") {
			return yield* Effect.die(new Error("the monetary context has no two fraction digits"))
		}
	})

export interface SqlNames {
	/** The quoted schema holding the test's domain. */
	readonly schema: string
	/** The quoted pgvector schema. */
	readonly vector: string
	/** The codes of the test's rosters, which a set's bit(n) is sized by. */
	readonly codes: Codebook
}

/**
 * The SQL type a value of this descriptor is declared as on the wire (a recordset column or a parameter cast): the
 * base type for a contract, numeric for money, a closed id's code as smallint, a set as bit(n) with n its roster's codes,
 * holes included, and an exact value as the lowering types it (bigint for an exact integer of at most 18 digits,
 * numeric otherwise).
 */
export const wireSql = (type: ScalarType, names: SqlNames): string => {
	switch (type.carrier) {
		case "numeric":
			return type.typmod === undefined
				? "numeric"
				: `numeric(${type.typmod.precision},${type.typmod.scale})`
		case "money":
			return "numeric"
		case "code":
			return "int2"
		case "bits":
			return `bit(${codecOf(names.codes, type.roster).size})`
		case "vector":
			return `${names.vector}."vector"(${type.typmod.dims})`
		case "int2":
			return "int2"
		case "int4":
			return "int4"
		case "int8":
			return "int8"
		case "float4":
			return "real"
		case "float8":
			return "float8"
		case "bool":
			return "bool"
		case "uuid":
			return "uuid"
		case "date":
			return "date"
		case "text":
			return "text"
		case "range4":
			return "int4range"
		case "range8":
			return "int8range"
		case "exactInteger":
			return type.digits <= 18 ? "int8" : "numeric"
		case "exactMoney":
			return "numeric"
	}
}

/** The outermost SELECT's text form of a stored column's expression, through the codec's resultTextCasts. */
export const storedTextOut = (type: ScalarType, expr: string): string =>
	Arr.reduce(resultTextCasts(type), expr, (e, cast) => `(${e})::${cast}`)

/**
 * The outermost SELECT's text form of a wire expression: a wire expression of money is numeric and becomes money first,
 * where a stored money column is already money.
 */
export const textOut = (type: ScalarType, expr: string): string =>
	storedTextOut(type, type.carrier === "money" ? `(${expr})::money` : expr)
