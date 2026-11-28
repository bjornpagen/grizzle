/** What the properties of registry.test.ts read: its spaces, models and helpers. */

import { type Gen, int, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Result } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import type { Capability, Carrier } from "#compiler/ir/scalar.ts"
import { nativeCapabilities } from "#compiler/scalar/native.ts"
import {
	numericMaxPrecision,
	numericMaxScale,
	numericMinScale
} from "#compiler/scalar/values/fault.ts"
import type { CaseSession } from "#test/support/substrate/session.ts"

/**
 * The catalog type of each carrier; a closed id is probed through smallint, the type of its code under its roster's
 * domain, a set through bit, ranges through int4range and int8range, and the exact carriers through numeric, the type
 * an exact value of any digit bound is.
 */
export const carrierTypes = (vectorSchema: string): Readonly<Record<Carrier, string>> => ({
	int2: "int2",
	int4: "int4",
	int8: "int8",
	numeric: "numeric",
	float4: "float4",
	float8: "float8",
	money: "money",
	bool: "bool",
	uuid: "uuid",
	sha256: "bytea",
	date: "date",
	inet: "inet",
	cidr: "cidr",
	text: "text",
	bytes: "bytea",
	code: "int2",
	bits: "bit",
	range4: "int4range",
	range8: "int8range",
	rangeDate: "daterange",
	vector: `${vectorSchema}.vector`,
	tsvector: "tsvector",
	exactInteger: "numeric",
	exactMoney: "numeric",
	variant: "record"
})

/**
 * The input type PostgreSQL resolves an operator class or aggregate over where it is not the carrier's own: a generic
 * carrier's polymorphic type, and inet for a cidr, which is binary-coercible to inet and has no operator, class or
 * aggregate of its own (pg_cast, pg_opclass's cidr_ops over inet).
 */
export const polymorphic: Readonly<Partial<Record<Carrier, string>>> = {
	range4: "anyrange",
	range8: "anyrange",
	rangeDate: "anyrange",
	cidr: "inet"
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

export const catalogNames: ReadonlyArray<string> = catalogCapabilities

/** Native capabilities the language does not admit, each with its reason. Nothing else may differ from the catalog. */
export const exclusions: Readonly<
	Partial<Record<Carrier, ReadonlyArray<(typeof catalogCapabilities)[number]>>>
> = {
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
	/** An exact field is never a key's (KeyFault exactValue), so no key or constraint indexes one by GiST. */
	exactInteger: ["gist"],
	/** Nor exact money's; a mean over money is no aggregate of the language, as money's own avg is not. */
	exactMoney: ["avg", "gist"],
	/**
	 * A bytes value is stored and read back whole, and that is all (scalar/bytes.ts): no key, unique, containment,
	 * comparison or aggregate reads one.
	 */
	bytes: ["equality", "gist", "hashing", "minMax", "ordering"],
	/**
	 * A digest is an identifier: two are one or not, and ordered only so a B-tree indexes its keys (scalar/native.ts), so
	 * no aggregate of the language takes the least or greatest of digests, though PostgreSQL 18 and later have min(bytea)
	 * and max(bytea).
	 */
	sha256: ["minMax"],
	/**
	 * A cidr's min and max are inet's (min(inet), max(inet)), which answer an inet: a cidr's least value is no cidr the
	 * language types, so no aggregate of the language reads one.
	 */
	cidr: ["minMax"],
	/**
	 * A search document is read back whole, matched against a query and ranked by PostgreSQL, and that is all
	 * (scalar/native.ts, ir/scalar.ts SearchType): no key, rule or comparison reads one, so its equality, B-tree and
	 * GiST classes are none of the language's.
	 */
	tsvector: ["equality", "gist", "ordering"],
	/**
	 * A variant has equality and hashing and no stated order (scalar/native.ts, ir/scalar.ts VariantType): its
	 * composite's B-tree order is the tag's code, then the arm's fields, an order of codes no roster states, so no
	 * comparison, ORDER BY or least or greatest of the language reads one, and a completed order breaks ties by it
	 * alone (scalar/registry.ts breaksTies).
	 */
	variant: ["minMax", "ordering"]
}

/** The capabilities the registry claims for a carrier. */
export const claimedBy = (carrier: Carrier): ReadonlyArray<Capability> =>
	nativeCapabilities[carrier]

/**
 * The carriers PostgreSQL has a discrete range over that grizzle declares no span over, each with the README's named
 * limit (Limits, "A span is over integer or bigint"). Nothing else may differ from the catalog.
 */
export const unspanned: Readonly<Partial<Record<Carrier, string>>> = {
	date: "daterange: grizzle declares no span carrier over a date yet"
}

/** What a carrier reached: an excluded native capability, and its range endpoints against the discrete ranges. */
export type CarrierFeature =
	| "a native capability excluded"
	| "a spannable carrier"
	| "a discrete range named as a limit"
	| "no discrete range"

/** The text a probe stored for spelling i: every spelling has one. */
export const storedAt = (stored: ReadonlyArray<string>, i: number): string => {
	const s = stored[i]
	if (s === undefined) {
		throw new Error(`no stored type for spelling ${i}`)
	}
	return s
}

/** What the catalog offers on one type, over the capability vocabulary. */
export const nativeOf = (db: CaseSession, type: string, poly: string | undefined) =>
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
export const installProbe = (db: CaseSession) =>
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

export const probe = (db: CaseSession, spellings: ReadonlyArray<string>) =>
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

/**
 * The pg_type.typname PostgreSQL stores a column of each spelling as, in their order: a temporary table of one column of
 * the spelling, its attribute's type read off pg_type and the table dropped, in the case's transaction.
 */
export const typnamesOf = (db: CaseSession, spellings: ReadonlyArray<string>) =>
	Effect.forEach(spellings, (spelling) =>
		Effect.gen(function* () {
			yield* db.query(`CREATE TEMPORARY TABLE typname_t (v ${spelling})`, [])
			const rows = yield* db.values(
				"SELECT t.typname::text FROM pg_catalog.pg_attribute AS a JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid WHERE a.attrelid = 'typname_t'::regclass AND a.attname = 'v'",
				[]
			)
			yield* db.query("DROP TABLE typname_t", [])
			return Arr.map(rows, (row) => String(row[0]))
		})
	).pipe(Effect.map(Arr.flatten))

export const accepts = (f: () => unknown): boolean => Result.isSuccess(Result.try(f))

/** A precision or a scale near numerictypmodin's bounds, or anywhere past them on either side. */
const nearBounds = (bounds: ReadonlyArray<number>, far: number): Gen<number> =>
	oneOf([int(-far, far), ...Arr.map(bounds, (bound) => int(bound - 2, bound + 2))])

/** A numeric typmod: its precision near 1 and numericMaxPrecision, its scale near 0 and both scale bounds. */
export const typmodGen: Gen<readonly [number, number]> = (source) =>
	[
		source.draw(nearBounds([1, numericMaxPrecision], numericMaxPrecision + 10)),
		source.draw(nearBounds([numericMinScale, 0, numericMaxScale], numericMaxScale + 10))
	] as const

/** What a vector dimension count reached: refused below, admitted, refused above. */
export type DimensionsFeature = "refused below" | "admitted" | "refused above"
