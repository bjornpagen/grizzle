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
	/**
	 * inet's B-tree, hash and GiST classes, network_ops' inet_ops (PostgreSQL 19 makes GiST's inet_ops the default class
	 * of inet and cidr, and btree_gist 1.9 its own gist_inet_ops no default), min and max (network_smaller,
	 * network_larger), and the containment operators <<=, << and &&, which inet_ops' GiST class serves.
	 */
	inet: [
		"equality",
		"expressionIndex",
		"gist",
		"hashing",
		"minMax",
		"netContainment",
		"ordering",
		"storage"
	],
	/**
	 * cidr reads inet's operators and classes through its binary coercion to inet. PostgreSQL has no min or max over
	 * cidr: inet's would deliver an inet, of another text than the cidr it chose.
	 */
	cidr: ["equality", "expressionIndex", "gist", "hashing", "netContainment", "ordering", "storage"],
	text: ["equality", "expressionIndex", "gist", "hashing", "minMax", "ordering", "storage"],
	/**
	 * bytea has equality, a B-tree and a hash class, but grizzle admits storage alone: a bytes value is written and read
	 * back whole, so no key, rule, computation, parameter or filter reads one.
	 */
	bytes: ["storage"],
	/**
	 * A digest is bytea of exactly 32 bytes: bytea_ops for B-tree, its hash class, and btree_gist's gist_bytea_ops, which
	 * compare its bytes. PostgreSQL's min(bytea) and max(bytea) are none of the language's: a digest is an identifier,
	 * ordered only so a B-tree indexes its keys, so no aggregate takes the least or greatest of digests.
	 */
	sha256: ["equality", "expressionIndex", "gist", "hashing", "ordering", "storage"],
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
	/**
	 * tsvector has equality, a B-tree, a GiST and a GIN class, but grizzle admits storage and its full text search alone:
	 * a search document is read back whole, matched against a query and ranked by PostgreSQL, so no key, rule, comparison,
	 * parameter or host computation reads one (ir/scalar.ts SearchType).
	 */
	tsvector: ["storage", "textSearch"],
	/**
	 * Numeric's operations over integers, an exact integer field's (scalar/exact.ts) among them, and no GiST. Its set
	 * names the operations a term of it takes; a field of it is stored and read back as every value type's field is,
	 * which no admission reads off a capability (storage marks a type of storage alone, storedOnly).
	 */
	exactInteger: ["avg", "equality", "expressionIndex", "hashing", "minMax", "ordering", "sum"],
	/**
	 * Numeric's over amounts at scale 2, an exact money field's among them, reached through money's STABLE cast: no
	 * expression index, no avg.
	 */
	exactMoney: ["equality", "hashing", "minMax", "ordering", "sum"],
	/**
	 * A variant is a domain over a composite (ir/scalar.ts VariantType): record_eq, hash_record and record_cmp read two
	 * absent attributes as equal, so it compares equal, hashes and indexes as the sum it is, tag then the arm's fields.
	 * It has no stated order, no aggregate and no GiST class: its record order, the tag's code and then the arm's fields,
	 * only breaks a completed order's ties (scalar/registry.ts breaksTies).
	 */
	variant: ["equality", "hashing", "storage"]
} as const satisfies { readonly [C in Carrier]: ReadonlyArray<Capability> }

/**
 * The capabilities of a closed id of an unordered roster (ir/scalar.ts RosterOrder): a closed id's but ordering and
 * minMax, since its codes are history and no handle comes before another. Its code still compares equal, hashes,
 * indexes and joins as a smallint's.
 */
export const unorderedCodeCapabilities = [
	"equality",
	"expressionIndex",
	"gist",
	"hashing",
	"storage"
] as const satisfies ReadonlyArray<Capability>

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
	| "inet"
	| "cidr"
	| "sha256"

/** The plain result type of a carrier, frozen: no contract. */
export const plainType = (carrier: PlainCarrier): ScalarType =>
	Object.freeze({ carrier, caps: capabilitySet(nativeCapabilities[carrier]), contract: undefined })
