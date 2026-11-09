import {
	type Capability,
	type Carrier,
	capabilitySet,
	type ScalarType
} from "#compiler/ir/scalar.ts"

/** The native capabilities of each carrier, as const so the type level reads the same table (types/fields). */
export const nativeCapabilities = {
	int2: [
		"avg",
		"equality",
		"expressionIndex",
		"gist",
		"hashing",
		"minMax",
		"ordering",
		"storage",
		"sum"
	],
	int4: [
		"avg",
		"equality",
		"expressionIndex",
		"gist",
		"hashing",
		"minMax",
		"ordering",
		"spanEndpoint",
		"storage",
		"sum"
	],
	int8: [
		"avg",
		"equality",
		"expressionIndex",
		"gist",
		"hashing",
		"minMax",
		"ordering",
		"spanEndpoint",
		"storage",
		"sum"
	],
	numeric: [
		"avg",
		"equality",
		"expressionIndex",
		"gist",
		"hashing",
		"minMax",
		"ordering",
		"storage",
		"sum"
	],
	float4: [
		"avg",
		"equality",
		"expressionIndex",
		"gist",
		"hashing",
		"minMax",
		"ordering",
		"storage",
		"sum"
	],
	float8: [
		"avg",
		"equality",
		"expressionIndex",
		"gist",
		"hashing",
		"minMax",
		"ordering",
		"storage",
		"sum"
	],
	/** No hash operator class and no avg(money). */
	money: ["equality", "expressionIndex", "gist", "minMax", "ordering", "storage", "sum"],
	/** r.min and r.max lower to bool_and and bool_or; there is no min(boolean), sum or avg. */
	bool: ["boolAgg", "equality", "expressionIndex", "gist", "hashing", "ordering", "storage"],
	/** PostgreSQL 19 has no min(uuid) or max(uuid). */
	uuid: ["equality", "expressionIndex", "gist", "hashing", "ordering", "storage"],
	/** date_ops for B-tree and hash, btree_gist's gist_date_ops, and min and max (date_smaller, date_larger). */
	date: ["equality", "expressionIndex", "gist", "hashing", "minMax", "ordering", "storage"],
	text: ["equality", "expressionIndex", "gist", "hashing", "minMax", "ordering", "storage"],
	/**
	 * bytea has equality, a B-tree and a hash class, but grizzle admits storage alone: a bytes value is written and read
	 * back whole, so no key, rule, computation, parameter or filter reads one.
	 */
	bytes: ["storage"],
	/** A closed id is its code, a smallint under its roster's domain, ordered by code: int2's classes and order. */
	code: ["equality", "expressionIndex", "gist", "hashing", "minMax", "ordering", "storage"],
	/**
	 * bit has a B-tree class, bit_ops, and a BRIN class, and no hash or GiST class (pg_opclass.dat), and PostgreSQL has
	 * no min or max over it. Its own algebra is the set algebra: &, |, ~ and bit_count.
	 */
	bits: ["equality", "expressionIndex", "setAlgebra", "storage"],
	/** No min or max over a range; GiST is range_ops, the operator class every Allen atom uses. */
	range4: ["equality", "expressionIndex", "gist", "hashing", "ordering", "storage"],
	range8: ["equality", "expressionIndex", "gist", "hashing", "ordering", "storage"],
	rangeDate: ["equality", "expressionIndex", "gist", "hashing", "ordering", "storage"],
	/**
	 * pgvector's B-tree vector_ops gives equality and vector_cmp order; there is no hash or GiST class,
	 * and its sum and avg are not language aggregates. vectorDistance is cosine_distance over the cosine domain.
	 */
	vector: ["equality", "ordering", "storage", "vectorDistance"],
	/** Numeric's operations over integers, never a field's: no storage, no GiST. */
	exactInteger: ["avg", "equality", "expressionIndex", "hashing", "minMax", "ordering", "sum"],
	/** Numeric's over amounts at scale 2, reached through money's STABLE cast: no expression index, no avg. */
	exactMoney: ["equality", "hashing", "minMax", "ordering", "sum"]
} as const satisfies { readonly [C in Carrier]: ReadonlyArray<Capability> }

/**
 * The plain carriers an operation result can have without further metadata. numeric is none: a computed numeric
 * carries its bound (numericValue).
 */
export type PlainCarrier =
	| "int2"
	| "int4"
	| "int8"
	| "float4"
	| "float8"
	| "money"
	| "bool"
	| "date"

/** The plain result type of a carrier, frozen: no contract. */
export const plainType = (carrier: PlainCarrier): ScalarType =>
	Object.freeze({ carrier, caps: capabilitySet(nativeCapabilities[carrier]), contract: undefined })
