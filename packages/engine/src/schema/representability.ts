import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { nominal } from "#compiler/core/brand.ts"
import type { KeyFault } from "#compiler/core/causes.ts"
import { sha256Octets } from "#compiler/core/digest.ts"
import type { EntryRole } from "#compiler/core/identity.ts"
import {
	blockSize,
	heapTupleHeaderBytes,
	itemIdBytes,
	pageHeaderBytes
} from "#compiler/core/page.ts"
import { int2Max } from "#compiler/ir/carriers.ts"
import type { ExprDesc, FieldDesc, VariantFieldDesc } from "#compiler/ir/desc.ts"
import type { ExactValueCarrier, NumericBound, TextLanguage } from "#compiler/ir/scalar.ts"
import { decDigits } from "#compiler/scalar/compute/numeric.ts"
import { utf8EncodingMaxBytes } from "#compiler/scalar/compute/typing.ts"
import { moneyFractionDigits } from "#compiler/scalar/values/decimal.ts"
import {
	numericMaxIntegerDigits,
	numericOwnBound,
	varlenaHeaderBytes
} from "#compiler/scalar/values/fault.ts"

/**
 * BITS_PER_BYTE, the bits PostgreSQL counts in one byte of a datum.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit bits
 * @scope one byte of a datum, as a bit string's length and a type's width count it
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/pg_config_manual.h#L111
 * @quote #define BITS_PER_BYTE 8
 * @verified 2026-11-20
 */
export const bitsPerByte = 8

/**
 * The most codes one roster numbers, its holes included. A closed-id field stores its handle's code as a smallint, and
 * a roster numbers its handles from 0 in the order they were declared, a removed handle leaving its code a hole, so a
 * code is one of smallint's non-negative values. A code is never negative because it is a digit of the mixed-radix
 * index a closed relation's constant is read at, where a negative one would borrow from the digit above it.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit codes
 * @scope the codes of one roster, its live handles' and its holes, each the smallint a closed-id column stores
 * @derivation smallint's non-negative values, 0 to its greatest: one code each
 * @from {@link int2Max}
 */
export const rosterMaxCodes = int2Max + 1

/**
 * The typlen of each fixed-size type a field, a range's endpoint or a varlena's part is: a smallint's is the bytes one
 * code takes in its closed-id column.
 */
export const typlens = {
	/**
	 * @limitKind published
	 * @owner PostgreSQL 19.0
	 * @unit bytes
	 * @scope one smallint datum, in a heap tuple and in an index entry
	 * @constraint compile-time constant
	 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/catalog/pg_type.dat#L62
	 * @quote typname => 'int2', typlen => '2', typbyval => 't'
	 * @verified 2026-11-20
	 */
	int2: 2,
	/**
	 * @limitKind published
	 * @owner PostgreSQL 19.0
	 * @unit bytes
	 * @scope one integer datum, in a heap tuple and in an index entry
	 * @constraint compile-time constant
	 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/catalog/pg_type.dat#L74
	 * @quote typname => 'int4', typlen => '4', typbyval => 't'
	 * @verified 2026-11-20
	 */
	int4: 4,
	/**
	 * @limitKind published
	 * @owner PostgreSQL 19.0
	 * @unit bytes
	 * @scope one bigint datum, in a heap tuple and in an index entry
	 * @constraint compile-time constant
	 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/catalog/pg_type.dat#L57
	 * @quote typname => 'int8', typlen => '8', typbyval => 't'
	 * @verified 2026-11-20
	 */
	int8: 8,
	/**
	 * @limitKind published
	 * @owner PostgreSQL 19.0
	 * @unit bytes
	 * @scope one real datum, in a heap tuple and in an index entry
	 * @constraint compile-time constant
	 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/catalog/pg_type.dat#L220
	 * @quote typname => 'float4', typlen => '4', typbyval => 't'
	 * @verified 2026-11-20
	 */
	float4: 4,
	/**
	 * @limitKind published
	 * @owner PostgreSQL 19.0
	 * @unit bytes
	 * @scope one double precision datum, in a heap tuple and in an index entry
	 * @constraint compile-time constant
	 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/catalog/pg_type.dat#L225
	 * @quote typname => 'float8', typlen => '8', typbyval => 't'
	 * @verified 2026-11-20
	 */
	float8: 8,
	/**
	 * @limitKind published
	 * @owner PostgreSQL 19.0
	 * @unit bytes
	 * @scope one money datum, in a heap tuple and in an index entry
	 * @constraint compile-time constant
	 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/catalog/pg_type.dat#L239
	 * @quote typname => 'money', typlen => '8', typbyval => 't'
	 * @verified 2026-11-20
	 */
	money: 8,
	/**
	 * @limitKind published
	 * @owner PostgreSQL 19.0
	 * @unit bytes
	 * @scope one boolean datum, in a heap tuple and in an index entry
	 * @constraint compile-time constant
	 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/catalog/pg_type.dat#L36
	 * @quote typname => 'bool', typlen => '1', typbyval => 't'
	 * @verified 2026-11-20
	 */
	bool: 1,
	/**
	 * @limitKind published
	 * @owner PostgreSQL 19.0
	 * @unit bytes
	 * @scope one oid datum, in a heap tuple and in an index entry
	 * @constraint compile-time constant
	 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/catalog/pg_type.dat#L89
	 * @quote typname => 'oid', typlen => '4', typbyval => 't'
	 * @verified 2026-11-20
	 */
	oid: 4,
	/**
	 * @limitKind published
	 * @owner PostgreSQL 19.0
	 * @unit bytes
	 * @scope one uuid datum, in a heap tuple and in an index entry
	 * @constraint compile-time constant
	 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/catalog/pg_type.dat#L409
	 * @quote typname => 'uuid', typlen => '16', typbyval => 'f'
	 * @verified 2026-11-20
	 */
	uuid: 16,
	/**
	 * @limitKind published
	 * @owner PostgreSQL 19.0
	 * @unit bytes
	 * @scope one date datum, in a heap tuple and in an index entry
	 * @constraint compile-time constant
	 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/catalog/pg_type.dat#L288
	 * @quote typname => 'date', typlen => '4', typbyval => 't'
	 * @verified 2026-11-20
	 */
	date: 4
} as const

/**
 * The greatest alignment PostgreSQL rounds a tuple and its parts to, MAXIMUM_ALIGNOF: 8 on every platform it builds
 * on, the alignment of int64 and double. An entry measured at the greatest alignment is at least its size at any.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope the alignment of a heap or index tuple, its header, its attributes and its line pointer's share of a page
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/meson.build#L1877-L1878
 * @quote we intentionally do not consider any types wider than 64 bits, as allowing MAXIMUM_ALIGNOF to exceed 8 would
 *   be too much of a penalty for disk and memory space
 * @verified 2026-11-20
 */
export const maxAlign = 8

/** `n` rounded up to a multiple of the alignment `a`, as PostgreSQL's TYPEALIGN rounds a size. */
export const alignUp = (n: number, a: number): number => Math.ceil(n / a) * a

/**
 * A tuple identifier, ItemPointerData.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope the heap tuple identifier an index tuple and a B-tree pivot carry
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/storage/itemptr.h#L30-L31
 * @quote The struct is designed to be six bytes long (it contains three int16 fields)
 * @verified 2026-11-20
 */
const itemPointerBytes = 6

/**
 * An index tuple's header, IndexTupleData: its heap tuple identifier and its two-byte t_info.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope the header of every B-tree and GiST index tuple
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/access/itup.h#L35-L51
 * @quote typedef struct IndexTupleData { ItemPointerData t_tid; unsigned short t_info; } IndexTupleData;
 * @verified 2026-11-20
 */
const indexTupleHeader = 8

/**
 * A B-tree page's special space, BTPageOpaqueData: two block numbers, a level, flags and a cycle id.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope the special space of every B-tree page
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/access/nbtree.h#L63-L70
 * @quote typedef struct BTPageOpaqueData { BlockNumber btpo_prev; BlockNumber btpo_next; uint32 btpo_level; uint16
 *   btpo_flags; BTCycleId btpo_cycleid; } BTPageOpaqueData;
 * @verified 2026-11-20
 */
const btreeOpaqueBytes = 16

/**
 * A GiST page's special space, GISTPageOpaqueData: an LSN, a block number, flags and the page id.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope the special space of every GiST page
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/access/gist.h#L80-L86
 * @quote typedef struct GISTPageOpaqueData { PageGistNSN nsn; BlockNumber rightlink; uint16 flags; uint16
 *   gist_page_id; } GISTPageOpaqueData;
 * @verified 2026-11-20
 */
const gistOpaqueBytes = 16

/**
 * The most bytes one set over a roster takes, uncompressed and in line: a bit(n) varlena of its header, its bit count
 * and a byte per eight bits, n its roster's codes. A roster's codes are installation data, which ownership does not
 * hold, so the bound is the one every installation's roster keeps within: its most codes.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope one set over a roster, its bit(n) datum
 * @derivation VARBITTOTALLEN(n), "#define VARBITTOTALLEN(BITLEN) (((BITLEN) + BITS_PER_BYTE-1)/BITS_PER_BYTE +
 *   VARHDRSZ + VARBITHDRSZ)" with VARBITHDRSZ sizeof(int32)
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/include/utils/varbit.h), at n the most codes a roster
 *   numbers
 * @from {@link varlenaHeaderBytes}, {@link typlens.int4}, {@link rosterMaxCodes}, {@link bitsPerByte}
 */
const bitsBytes = varlenaHeaderBytes + typlens.int4 + Math.ceil(rosterMaxCodes / bitsPerByte)

/**
 * A range's header, sizeof(RangeType): its varlena header and its range type's OID, which its bounds follow.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope the header of one range datum
 * @derivation sizeof(RangeType), "typedef struct { int32 vl_len_; Oid rangetypid; /* Following the OID are zero to two
 *   bound values, then a flags byte *\/ } RangeType;"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/include/utils/rangetypes.h#L25-L30), which
 *   range_serialize counts first: VARHDRSZ and an oid
 * @from {@link varlenaHeaderBytes}, {@link typlens.oid}
 */
const rangeHeaderBytes = varlenaHeaderBytes + typlens.oid

/**
 * A range's flags byte, after its bounds.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope the flags of one range datum
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/adt/rangetypes.c#L2072-L2073
 * @quote /* Add space for flag byte *\/ msize += sizeof(char);
 * @verified 2026-11-20
 */
const rangeFlagBytes = 1

/**
 * A numeric's header, NUMERIC_HDRSZ: its varlena header, its sign and display scale, and its weight.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope the long header of one numeric datum, the longest it takes
 * @derivation "#define NUMERIC_HDRSZ (VARHDRSZ + sizeof(uint16) + sizeof(int16))"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/adt/numeric.c#L178): VARHDRSZ and two
 *   16-bit fields, each a smallint's width
 * @from {@link varlenaHeaderBytes}, {@link typlens.int2}
 */
const numericHeaderBytes = varlenaHeaderBytes + typlens.int2 * 2

/**
 * A numeric's NBASE digit, NumericDigit, an int16.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope one NBASE digit of a numeric datum
 * @derivation "typedef int16 NumericDigit;"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/adt/numeric.c#L103), a smallint's width
 * @from {@link typlens.int2}
 */
const numericDigitBytes = typlens.int2

/**
 * A vector's header, offsetof(Vector, x): its varlena header, its dimension count and a reserved field.
 *
 * @limitKind derived
 * @owner pgvector 0.8.7
 * @unit bytes
 * @scope the header of one vector datum, which its components follow
 * @derivation offsetof(Vector, x) in VECTOR_SIZE, "#define VECTOR_SIZE(_dim) add_size(offsetof(Vector, x),
 *   mul_size(sizeof(float), _dim))" (https://github.com/pgvector/pgvector/blob/v0.8.7/src/vector.h#L13), of "typedef
 *   struct Vector { int32 vl_len_; int16 dim; int16 unused; float x[FLEXIBLE_ARRAY_MEMBER]; } Vector;"
 *   (https://github.com/pgvector/pgvector/blob/v0.8.7/src/vector.h#L18-L24): VARHDRSZ and two int16 fields, each a
 *   smallint's width; each component a C float, a real ("typedef float float4;", c.h)
 * @from {@link varlenaHeaderBytes}, {@link typlens.int2}
 */
const vectorHeaderBytes = varlenaHeaderBytes + typlens.int2 * 2

const alignDown = (n: number, a: number): number => Math.floor(n / a) * a

/**
 * The most bytes one B-tree entry takes: BTMaxItemSize, a third of a page, its pivot's heap tuple identifier left.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope one B-tree index entry, a key's index's among them
 * @derivation nbtree.h's BTMaxItemSize: MAXALIGN_DOWN((BLCKSZ - MAXALIGN(SizeOfPageHeaderData + 3*sizeof(ItemIdData))
 *   - MAXALIGN(sizeof(BTPageOpaqueData))) / 3) - MAXALIGN(sizeof(ItemPointerData))
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/include/access/nbtree.h#L165-L169), three entries to a
 *   page
 * @from {@link blockSize}, {@link maxAlign}, {@link pageHeaderBytes}, {@link itemIdBytes}, {@link btreeOpaqueBytes},
 *   {@link itemPointerBytes}
 */
export const btreeMaxItemSize =
	alignDown(
		(blockSize -
			alignUp(pageHeaderBytes + 3 * itemIdBytes, maxAlign) -
			alignUp(btreeOpaqueBytes, maxAlign)) /
			3,
		maxAlign
	) - alignUp(itemPointerBytes, maxAlign)

/**
 * The most bytes one GiST entry takes: an empty page, GiSTPageSize, less its one line pointer.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope one GiST index entry, a span key's among them
 * @derivation gist_private.h's GiSTPageSize, BLCKSZ - SizeOfPageHeaderData - MAXALIGN(sizeof(GISTPageOpaqueData))
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/include/access/gist_private.h#L474-L475), less the
 *   entry's one ItemIdData, as gistfitpage counts it
 * @from {@link blockSize}, {@link maxAlign}, {@link pageHeaderBytes}, {@link gistOpaqueBytes}, {@link itemIdBytes}
 */
export const gistMaxItemSize =
	blockSize - pageHeaderBytes - alignUp(gistOpaqueBytes, maxAlign) - itemIdBytes

/**
 * The most columns one index holds, INDEX_MAX_KEYS: a key's index has one per field.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit columns
 * @scope one index: a key's, a span key's GiST constraint, an access path's
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/pg_config_manual.h#L79
 * @quote #define INDEX_MAX_KEYS 32
 * @verified 2026-11-20
 */
export const indexMaxKeys = 32

/**
 * An index tuple's null bitmap, IndexAttributeBitMapData: a bit for each of INDEX_MAX_KEYS columns, whatever the index's
 * own count, which follows the header exactly when the tuple holds a null.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope the null bitmap of one index tuple that holds a null
 * @derivation "typedef struct IndexAttributeBitMapData { uint8 bits[(INDEX_MAX_KEYS + 8 - 1) / 8]; }"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/include/access/itup.h#L55-L58, verified 2026-11-20): a
 *   byte per eight of INDEX_MAX_KEYS bits, C's integer division
 * @from {@link indexMaxKeys}, {@link bitsPerByte}
 */
const indexNullBitmapBytes = Math.floor((indexMaxKeys + bitsPerByte - 1) / bitsPerByte)

/**
 * The most bytes an inet or cidr datum takes, in a heap tuple and in an index entry: its varlena header at its longest,
 * then inet_struct's family and mask length, a byte each, and an IPv6 address's 16 bytes. Its GiST key under inet_ops,
 * GistInetKey, is a short varlena of a family, two mask lengths and the same address, never longer.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope one inet or cidr datum, in a heap tuple and in an index entry, and its GiST key under inet_ops
 * @derivation "#define SET_INET_VARSIZE(dst) SET_VARSIZE(dst, VARHDRSZ + offsetof(inet_struct, ipaddr) +
 *   ip_addrsize(dst))" (https://github.com/postgres/postgres/blob/REL_19_0/src/include/utils/inet.h#L86-L88, verified
 *   2026-11-21), inet_struct's `unsigned char family; unsigned char bits; unsigned char ipaddr[16];` (#L23-L28), an
 *   IPv6 address's ip_addrsize 16; pg_type.dat's `typname => 'inet', typlen => '-1', ... typalign => 'i'`
 * @from {@link varlenaHeaderBytes}
 */
const inetDatumBytes = varlenaHeaderBytes + 1 + 1 + 16

/** The two bounds a range holds, and a btree_gist key of a fixed-size type beside each other. */
const bounds = ["lower", "upper"] as const

/**
 * Where an index tuple's first datum starts, IndexInfoFindDataOffset: its header, and its null bitmap where the tuple
 * holds a null, MAXALIGNed; index_form_tuple lays the datums out from there.
 */
const indexDataOffset = (nulls: boolean): number =>
	alignUp(indexTupleHeader + (nulls ? indexNullBitmapBytes : 0), maxAlign)

export interface DatumBound {
	/** The most bytes the datum occupies in an index tuple, its header included. */
	readonly bytes: number
	/** Its type's alignment in bytes. */
	readonly align: number
	/** The B-tree carrier family, which btree_gist's support and key representation depend on. */
	readonly family: Family
}

/**
 * Whether a datum's type is fixed-width (pg_type's typlen above 0): its bytes are exactly its typlen, at its
 * alignment, in an index tuple and a row alike. Every other family is a varlena, whose header and length vary with its
 * value.
 */
export const isFixedWidth = (bound: DatumBound): boolean => {
	switch (bound.family) {
		case "int2":
		case "int4":
		case "int8":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "code":
			return true
		case "inet":
		case "bit":
		case "bytea":
		case "numeric":
		case "text":
		case "range":
		case "vector":
		case "record":
			return false
	}
}

type Family =
	| "int2"
	| "int4"
	| "int8"
	| "float4"
	| "float8"
	| "money"
	| "bool"
	| "uuid"
	| "date"
	| "inet"
	| "code"
	| "bit"
	| "bytea"
	| "numeric"
	| "text"
	| "range"
	| "vector"
	| "record"

/**
 * The families a GiST class serves, the scalars a span key may hold: every family but vector and a variant's record,
 * inet's under core's inet_ops (GistInetKey), every other's under btree_gist's class.
 */
type GistFamily = Exclude<Family, "vector" | "record">
interface GistDatum extends DatumBound {
	readonly family: GistFamily
}

const fixed = (bytes: number, align: number, family: Family): DatumBound => ({
	bytes,
	align,
	family
})

/**
 * A set's datum over a roster of `codes` codes: its bit(n) varlena, VARBITTOTALLEN(n), aligned to 4, bitsBytes's
 * count at n `codes`. A declared key counts it at the most codes a roster numbers (bitsBytes); a family axis, which
 * carries a fold's set accumulators, at the codes it knows its roster has (laws/model/plan.ts #axis).
 */
export const setDatumBound = (codes: number): DatumBound =>
	fixed(varlenaHeaderBytes + typlens.int4 + Math.ceil(codes / bitsPerByte), 4, "bit")

/** The literal value of a length bound's operand. */
const literalCount = (e: ExprDesc): number | undefined => {
	if (e.kind !== "literal") {
		return undefined
	}
	const v = e.value
	if (typeof v === "number" && Number.isInteger(v)) {
		return v
	}
	if (
		typeof v === "bigint" &&
		v <= BigInt(Number.MAX_SAFE_INTEGER) &&
		v >= -BigInt(Number.MAX_SAFE_INTEGER)
	) {
		return Number(v)
	}
	return undefined
}

/**
 * A length a contract predicate bounds its value by: char_length, its code points (Text.charLength), or
 * octet_length, its UTF-8 bytes (Text.octetLength).
 */
export type LengthMeasure = "charLength" | "octetLength"

const isLengthOfValue = (measure: LengthMeasure, e: ExprDesc): boolean =>
	e.kind === "compute" && e.fn === measure && e.args.length === 1 && e.args[0]?.kind === "value"

/**
 * The upper bound a contract predicate puts on its value's `measure`, its char_length in code points or its
 * octet_length in bytes: measure(v) <= n, < n, = n, between(measure(v), lo, hi), in [...], their mirror images, and
 * conjunctions. Infinity, the top of the bounds' min order, when the predicate bounds no such length; -Infinity, the
 * greatest of no lengths, for an `in` of no values, which no length meets.
 */
export const lengthBound = (measure: LengthMeasure, predicate: ExprDesc): number => {
	const isMeasured = (e: ExprDesc): boolean => isLengthOfValue(measure, e)
	switch (predicate.kind) {
		case "and":
			return predicate.args.reduce(
				(bound, arg) => Math.min(bound, lengthBound(measure, arg)),
				Number.POSITIVE_INFINITY
			)
		case "compare": {
			const { op, left, right } = predicate
			if (isMeasured(left)) {
				const n = literalCount(right)
				if (n === undefined) {
					return Number.POSITIVE_INFINITY
				}
				return op === "le" || op === "eq" ? n : op === "lt" ? n - 1 : Number.POSITIVE_INFINITY
			}
			if (isMeasured(right)) {
				const n = literalCount(left)
				if (n === undefined) {
					return Number.POSITIVE_INFINITY
				}
				return op === "ge" || op === "eq" ? n : op === "gt" ? n - 1 : Number.POSITIVE_INFINITY
			}
			return Number.POSITIVE_INFINITY
		}
		case "between": {
			if (!isMeasured(predicate.arg)) {
				return Number.POSITIVE_INFINITY
			}
			return literalCount(predicate.high) ?? Number.POSITIVE_INFINITY
		}
		case "in": {
			if (!isMeasured(predicate.arg)) {
				return Number.POSITIVE_INFINITY
			}
			let max = Number.NEGATIVE_INFINITY
			for (const v of predicate.values) {
				if (typeof v === "number" && Number.isInteger(v)) {
					max = Math.max(max, v)
				} else if (typeof v === "bigint") {
					max = Math.max(max, Number(v))
				} else {
					return Number.POSITIVE_INFINITY
				}
			}
			return max
		}
		case "var":
		case "field":
		case "value":
		case "parent":
		case "param":
		case "literal":
		case "compute":
		case "cast":
		case "guarded":
		case "base":
		case "retype":
		case "cond":
		case "variant":
		case "when":
		case "or":
		case "not":
		case "allen":
		case "pointIn":
		case "absent":
		case "exists":
		case "closedAt":
		case "closedRow":
		case "closedHas":
		case "call":
			return Number.POSITIVE_INFINITY
	}
}

/**
 * The most UTF-8 bytes a pattern's language admits, as the text analysis proved it where its descriptor was admitted
 * (ir/scalar.ts TextLanguage): exact from the minimal DFA, structural above its bound, and the byte bound itself where
 * str.bytes cuts it tighter; Infinity for a tautology or a language the analysis bounds nowhere.
 */
const languageByteBound = (language: TextLanguage): number =>
	language.kind === "every"
		? Number.POSITIVE_INFINITY
		: (language.check.bounds?.bytes ?? Number.POSITIVE_INFINITY)

/**
 * The most UTF-8 bytes a contract predicate admits of its text value: its octet_length bound, exact, and its
 * char_length bound, utf8EncodingMaxBytes a code point, whichever is less; Infinity when it bounds neither.
 */
const predicateByteBound = (predicate: ExprDesc): number =>
	Math.min(
		Math.max(0, lengthBound("charLength", predicate)) * utf8EncodingMaxBytes,
		Math.max(0, lengthBound("octetLength", predicate))
	)

/**
 * The most UTF-8 bytes a text-valued descriptor admits, declared or inferred: its pattern's bound, tightened by every
 * contract's predicate bound on the way down (predicateByteBound); Infinity when nothing bounds it.
 */
export const textByteBound = (desc: FieldDesc): number => {
	if (desc.kind === "text") {
		return languageByteBound(desc.language)
	}
	if (desc.kind === "contract") {
		return Math.min(
			textByteBound(desc.base),
			desc.predicate === undefined ? Number.POSITIVE_INFINITY : predicateByteBound(desc.predicate)
		)
	}
	return Number.POSITIVE_INFINITY
}

const isTextDesc = (desc: FieldDesc): boolean =>
	desc.kind === "text" || (desc.kind === "contract" && isTextDesc(desc.base))

/** Whether a span's endpoint is a date, date itself or a contract over it: a daterange's, of 4-byte bounds. */
const isDateEndpoint = (desc: FieldDesc): boolean =>
	desc.kind === "contract" ? isDateEndpoint(desc.base) : desc.kind === "pg" && desc.type === "date"

const integerFamily = (desc: FieldDesc): "int4" | "int8" | undefined => {
	switch (desc.kind) {
		case "contract":
			return integerFamily(desc.base)
		case "pg":
			return desc.type === "integer" ? "int4" : desc.type === "bigint" ? "int8" : undefined
		case "numeric":
		case "exact":
		case "computedNumeric":
		case "uuid":
		case "bytes":
		case "sha256":
		case "text":
		case "pattern":
		case "span":
		case "closedId":
		case "bits":
		case "vector":
		case "search":
		case "variant":
			return undefined
	}
}

/** The largest index datum of a PostgreSQL scalar type: each is fixed-size. */
const pgDatumBound = (type: Extract<FieldDesc, { readonly kind: "pg" }>["type"]): DatumBound => {
	switch (type) {
		case "smallint":
			return fixed(typlens.int2, 2, "int2")
		case "integer":
			return fixed(typlens.int4, 4, "int4")
		case "bigint":
			return fixed(typlens.int8, 8, "int8")
		case "numeric":
			return numericDatum(numericOwnBound)
		case "real":
			return fixed(typlens.float4, 4, "float4")
		case "double precision":
			return fixed(typlens.float8, 8, "float8")
		case "money":
			return fixed(typlens.money, 8, "money")
		case "boolean":
			return fixed(typlens.bool, 1, "bool")
		case "date":
			return fixed(typlens.date, 4, "date")
		case "inet":
		case "cidr":
			return fixed(inetDatumBytes, 4, "inet")
	}
}

/**
 * numeric.c numeric_maximum_size, "return NUMERIC_HDRSZ + (numeric_digits * sizeof(NumericDigit));": the most bytes a
 * numeric of `precision` significant digits takes, its header and a NumericDigit per NBASE digit,
 * `(precision + 2 * (DEC_DIGITS - 1)) / DEC_DIGITS` of them, a leading and a trailing partial group included. A
 * computed numeric of `digits` integer and `scale` fraction digits is one of digits + scale, since its two parts'
 * groups, ceil(digits / DEC_DIGITS) + ceil(scale / DEC_DIGITS), are never more.
 */
const numericMaximumSize = (precision: number): number =>
	numericHeaderBytes + numericDigitBytes * Math.floor((precision + 2 * (decDigits - 1)) / decDigits)

/**
 * The largest datum of numeric of no typmod within `bound` (ir/scalar.ts NumericBound): a computed numeric's, and
 * pg.numeric's at numeric's own limits, whose widest value no B-tree entry holds, so a key over one is refused and a
 * lookup leaves it out as a filter (`lookupEntry`).
 */
const numericDatum = (bound: NumericBound): DatumBound =>
	fixed(numericMaximumSize(bound.digits + bound.scale), 4, "numeric")

/**
 * The largest datum of an exact field (ir/desc.ts FieldDesc exact), numeric of no typmod at numeric's own limit: an
 * exact integer's integer digits, scale 0, and exact money's with money's fraction digits, its stored scale. Its widest
 * value no B-tree entry holds: no key holds one (exactKeyFault), and a lookup leaves one out of its index, a filter
 * beside it (`lookupEntry`), as a pg.numeric of no typmod.
 */
const exactDatum: { readonly [C in ExactValueCarrier]: DatumBound } = {
	exactInteger: numericDatum({ digits: numericMaxIntegerDigits, scale: 0 }),
	exactMoney: numericDatum({ digits: numericMaxIntegerDigits, scale: moneyFractionDigits })
}

/**
 * range_serialize's size of a range over an endpoint of `endpoint` bytes, both bounds present: its header, which is
 * MAXALIGNed, its two bounds, each at its own width's alignment and so unpadded, and its flags byte.
 */
const rangeBytes = (endpoint: number): number =>
	rangeHeaderBytes + bounds.length * endpoint + rangeFlagBytes

/**
 * The largest index datum of a field, declared or inferred; undefined for bytes and for text whose pattern proves no
 * byte bound. A digest is a bytea of sha256Octets bytes (core/sha256.ts), at its longest header, bytea's int alignment.
 */
export const datumBound = (desc: FieldDesc): DatumBound | undefined => {
	switch (desc.kind) {
		case "contract":
			if (isTextDesc(desc)) {
				break
			}
			return datumBound(desc.base)
		case "pg":
			return pgDatumBound(desc.type)
		case "uuid":
			return fixed(typlens.uuid, 1, "uuid")
		case "sha256":
			return fixed(varlenaHeaderBytes + sha256Octets, 4, "bytea")
		case "closedId":
			return fixed(typlens.int2, 2, "code")
		case "bits":
			return fixed(bitsBytes, 4, "bit")
		case "numeric":
			return fixed(numericMaximumSize(desc.precision), 4, "numeric")
		case "exact":
			return exactDatum[desc.carrier]
		case "computedNumeric":
			return numericDatum(desc.bound)
		case "span":
			return isDateEndpoint(desc.endpoint)
				? fixed(rangeBytes(typlens.date), 4, "range")
				: integerFamily(desc.endpoint) === "int4"
					? fixed(rangeBytes(typlens.int4), 4, "range")
					: fixed(rangeBytes(typlens.int8), 8, "range")
		case "vector":
			return fixed(vectorHeaderBytes + typlens.float4 * desc.dimensions, 4, "vector")
		case "variant":
			return variantDatum(desc)
		case "bytes":
		case "pattern":
		case "search":
			return undefined
		case "text":
			break
	}
	const bytes = textByteBound(desc)
	return Number.isFinite(bytes) ? fixed(varlenaHeaderBytes + bytes, 4, "text") : undefined
}

/**
 * The largest datum of a variant's composite (ir/scalar.ts VariantType), as heap_form_tuple lays one out and an index
 * entry holds it: its tuple header, SizeofHeapTupleHeader, whose first word is the datum's varlena length, and its null
 * bitmap, a bit per attribute, since every value leaves every other arm's attributes NULL, MAXALIGNed, which is t_hoff;
 * then its tag's code, a smallint, and its arm's attributes, each at its worst alignment padding and its longest, the
 * other arms' NULL attributes taking none, at the widest arm; aligned as a record is, `d`. Undefined where an arm's
 * field has no bound, a text of no byte bound, which no key entry holds.
 */
const variantDatum = (desc: VariantFieldDesc): DatumBound | undefined => {
	const attributes = 1 + desc.arms.reduce((n, arm) => n + arm.fields.length, 0)
	const header = alignUp(heapTupleHeaderBytes + Math.ceil(attributes / bitsPerByte), maxAlign)
	let widest = 0
	for (const arm of desc.arms) {
		let data = typlens.int2
		for (const field of arm.fields) {
			const datum = datumBound(field.desc)
			if (datum === undefined) {
				return undefined
			}
			data += datum.align - 1 + datum.bytes
		}
		widest = Math.max(widest, data)
	}
	return fixed(header + widest, maxAlign, "record")
}

/**
 * A column of an index entry: its name, the datum it holds at most, and whether it may hold NULL, as a law column
 * generated outside its guard may; a declared field is NOT NULL.
 */
export interface EntryColumn {
	readonly name: string
	readonly datum: DatumBound
	readonly nullable: boolean
}

/**
 * The most bytes a B-tree tuple over these columns reaches in any order of them, as index_form_tuple lays one out
 * (src/backend/access/common/indextuple.c, and heaptuple.c fill_val for each datum): its datums start at
 * IndexInfoFindDataOffset (indexDataOffset), past its header and, where any column may be NULL, its null bitmap; each
 * datum is counted after its worst alignment padding, align - 1, which bounds the padding at any offset, and a varlena
 * at its longest, its four-byte header aligned, since a one-byte header is never aligned and never longer; the whole is
 * MAXALIGNed. No order's layout exceeds it, so it is a function of the column set: a key, the UNIQUE a reference lands
 * on and the reference list one set in their own orders, and PostgreSQL matches a foreign key to a unique index over
 * its columns in any order (tablecmds.c transformFkeyCheckAttrs), so whether an index of a set fits never depends on
 * which order one lists it in. It is the bound keyTextBytes sizes a text by (`textBytesBeside`).
 */
export const btreeEntryBytes = (columns: ReadonlyArray<EntryColumn>): number =>
	alignUp(
		columns.reduce(
			(offset, c) => afterAtWorst(offset, c.datum),
			indexDataOffset(columns.some((c) => c.nullable))
		),
		maxAlign
	)

/** The offset past `datum` laid out at `offset` or after, at its worst alignment padding and its longest. */
const afterAtWorst = (offset: number, datum: DatumBound): number =>
	offset + datum.align - 1 + datum.bytes

declare const btreeEntryBrand: unique symbol

/**
 * The most bytes a B-tree entry over some columns can reach, proved within BTMaxItemSize: minted by btreeEntry alone, so
 * a value of it is that check's result.
 */
export type BtreeEntryBytes = number & { readonly [btreeEntryBrand]: true }

const provedEntry = nominal<number, BtreeEntryBytes>()

/**
 * btree_gist's key representation of a scalar datum (contrib/btree_gist): a fixed type stores its lower and upper
 * bound side by side, two datums of its width; numeric and text store both bounds as varlenas in one varlena, the
 * lower one INTALIGNed (btree_utils_var.c). A range is its own key under range_ops.
 */
const gistKeyBytes = (d: GistDatum): number => {
	switch (d.family) {
		case "int2":
		case "int4":
		case "float4":
		case "code":
		case "int8":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
			return bounds.length * d.bytes
		case "inet":
			return d.bytes
		case "numeric":
		case "text":
		case "bit":
		case "bytea":
			return varlenaHeaderBytes + alignUp(d.bytes, 4) + d.bytes
		case "range":
			return d.bytes
	}
}

/** The most bytes a GiST tuple over these key datums can reach. */
const keyGistEntryBytes = (datums: ReadonlyArray<GistDatum>): number => {
	let size = indexTupleHeader
	for (const d of datums) {
		size += maxAlign - 1 + gistKeyBytes(d)
	}
	return alignUp(size, maxAlign)
}

/** The most bytes a GiST tuple over these fields' datums can reach, or the first field btree_gist cannot index. */
export const gistEntryBytes = (
	fields: ReadonlyArray<{ readonly field: string; readonly datum: DatumBound }>
): Result.Result<number, string> => {
	const keys: Array<GistDatum> = []
	for (const { field, datum } of fields) {
		if (datum.family === "vector" || datum.family === "record") {
			return Result.err(field)
		}
		keys.push({ bytes: datum.bytes, align: datum.align, family: datum.family })
	}
	return Result.ok(keyGistEntryBytes(keys))
}

/**
 * A span key's GiST layout: its scalar fields through btree_gist, then its span last, and the most bytes its entry can
 * reach; or the fault of a scalar field btree_gist has no operator class for, or of an entry above a GiST page.
 */
const spanKeyGist = (
	datums: ReadonlyArray<{ readonly field: string; readonly datum: DatumBound }>,
	span: { readonly field: string; readonly datum: DatumBound }
): Result.Result<{ readonly span: string; readonly bytes: GistEntryBytes }, KeyFault> =>
	Result.map(
		gistEntry(
			datums.filter((d) => d.field !== span.field),
			span
		),
		(bytes) => ({ span: span.field, bytes })
	)

declare const gistEntryBrand: unique symbol

/**
 * The most bytes a span key's GiST entry can reach, proved within a GiST page: minted by gistEntry alone, so a value of
 * it is that check's result.
 */
export type GistEntryBytes = number & { readonly [gistEntryBrand]: true }

const provedGist = nominal<number, GistEntryBytes>()

/**
 * A span key's GiST entry, its scalar columns through btree_gist and then its span, its bytes proved within a GiST
 * page, or the fault of a scalar column btree_gist has no operator class for, or of an entry past the page. The one
 * check every WITHOUT OVERLAPS grizzle installs passes: a declared span key's and a span key over a projected side.
 * A column that may be NULL needs no more: a NULL drops its key, which takes more than the null bitmap adds.
 */
export const gistEntry = (
	scalars: ReadonlyArray<{ readonly field: string; readonly datum: DatumBound }>,
	span: { readonly field: string; readonly datum: DatumBound }
): Result.Result<GistEntryBytes, KeyFault> => {
	const bytes = gistEntryBytes([...scalars, span])
	if (!bytes.ok) {
		return Result.err({ kind: "gistOperatorClass", field: bytes.error })
	}
	return bytes.value > gistMaxItemSize
		? Result.err({ kind: "gistEntry", bytes: bytes.value, limit: gistMaxItemSize })
		: Result.ok(provedGist(bytes.value))
}

export interface KeyLayout {
	readonly fields: ReadonlyArray<string>
	readonly btreeBytes: BtreeEntryBytes
	/**
	 * A span key's GiST layout: its span field, placed last in its WITHOUT OVERLAPS constraint, and the most bytes its
	 * GiST entry can reach. A key without a span field has none.
	 */
	readonly gist: { readonly span: string; readonly bytes: GistEntryBytes } | undefined
}

const isSpanDesc = (desc: FieldDesc): boolean =>
	desc.kind === "span" || (desc.kind === "contract" && isSpanDesc(desc.base))

/**
 * A key's fields with their descriptors, each a field of the keyed relation: a declared key's, or a derived relation's
 * inherited one's, whose fields are inferred.
 */
export type KeyFields = ReadonlyArray<{
	readonly field: string
	readonly desc: FieldDesc
}>

/**
 * What an exact field of each carrier is, as a key's refusal names it, and the types of a declared precision that hold
 * its values, the fix it names (KeyFault exactValue).
 */
const exactKeyFix: {
	readonly [C in ExactValueCarrier]: { readonly type: string; readonly precision: string }
} = {
	exactInteger: {
		type: "an exact integer",
		precision: "pg.numeric(p, 0), an integer of at most p digits read as a bigint, or pg.bigint"
	},
	exactMoney: {
		type: "exact money",
		precision: "pg.numeric(p, 2), or pg.money, a signed 64-bit count of cents"
	}
}

/**
 * The fault of a key's field no key holds whatever its fellows, by its type alone: an exact field of any size, whose
 * widest value no entry holds (exactValue), its fix a precision (exactKeyFix); none for any other, which its datum
 * sizes. Every key reads it, a declared one's (keyLayout), an inherited one's (analysis/derived/keys.ts) and the law
 * model's UNIQUEs and axes (laws/model/plan.ts); a lookup sizes an exact field as a numeric's datum, which leaves it a
 * filter beside its index.
 */
export const exactKeyFault = (field: string, desc: FieldDesc): KeyFault | undefined =>
	desc.kind === "exact" ? { kind: "exactValue", field, ...exactKeyFix[desc.carrier] } : undefined

/** The first exact field of a key's fields, as its fault (exactKeyFault); none where the key holds none. */
export const exactKeyFields = (fields: KeyFields): KeyFault | undefined =>
	fields.reduce<KeyFault | undefined>(
		(fault, { field, desc }) => fault ?? exactKeyFault(field, desc),
		undefined
	)

/**
 * The bounded datums of a key's fields, or why the key has none: more columns than one index holds, a bytes field,
 * which is stored only, or a field whose datum has no bound. The rule every key's index entry starts from, a declared key's (keyLayout) and an inherited
 * one's (analysis/derived/keys.ts derivedKeyLayout).
 */
export const keyDatums = (fields: KeyFields): Result.Result<KeyDatums, KeyFault> =>
	datumsBy(fields, (desc) => datumBound(desc))

/** A key's fields with their descriptors and the datum its index entry holds for each, in key order. */
type KeyDatums = ReadonlyArray<{
	readonly field: string
	readonly desc: FieldDesc
	readonly datum: DatumBound
}>

/** Each field's datum as `datumOf` reads its descriptor, or the key's fault (`keyDatums`). */
const datumsBy = (
	fields: KeyFields,
	datumOf: (desc: FieldDesc, at: number) => DatumBound | undefined
): Result.Result<KeyDatums, KeyFault> => {
	if (fields.length > indexMaxKeys) {
		return Result.err({ kind: "columns", limit: indexMaxKeys })
	}
	const out: Array<KeyDatums[number]> = []
	for (const [at, { field, desc }] of fields.entries()) {
		if (desc.kind === "bytes") {
			return Result.err({ kind: "storageOnly", field })
		}
		const bound = datumOf(desc, at)
		if (bound === undefined) {
			return Result.err({ kind: "unboundedText", field })
		}
		out.push({ field, desc, datum: bound })
	}
	return Result.ok(out)
}

/** A key's bounded datums as its index's columns, in key order: a key's fields are NOT NULL. */
export const keyColumns = (
	datums: ReadonlyArray<{ readonly field: string; readonly datum: DatumBound }>
): ReadonlyArray<EntryColumn> =>
	datums.map((d) => ({ name: d.field, datum: d.datum, nullable: false }))

/**
 * A B-tree entry over `columns`, its bytes proved within BTMaxItemSize, or the fault of one that can exceed it, naming
 * its bytes and the bytes each column's datum is counted at. The one check every B-tree index grizzle installs passes: a
 * declared or inherited key's, and each UNIQUE and index the law model plans; PostgreSQL refuses a write whose entry
 * outgrows it (54000).
 */
export const btreeEntry = (
	columns: ReadonlyArray<EntryColumn>
): Result.Result<BtreeEntryBytes, KeyFault> => {
	const bytes = btreeEntryBytes(columns)
	return bytes > btreeMaxItemSize
		? Result.err({
				kind: "btreeEntry",
				bytes,
				limit: btreeMaxItemSize,
				datums: columns.map((c) => ({ field: c.name, bytes: c.datum.bytes }))
			})
		: Result.ok(provedEntry(bytes))
}

/**
 * A column a lookup's B-tree may hold: its name, its widest datum (none for a text of no byte bound or a bytes field,
 * which no entry holds), whether it may hold NULL, and what the lookup does with it (core/identity.ts EntryRole).
 */
export interface LookupColumn {
	readonly name: string
	readonly datum: DatumBound | undefined
	readonly nullable: boolean
	readonly role: EntryRole
}

/** The bytes a lookup's column is counted at where it is left out, a column of no bound the widest of all. */
const widthOf = (c: LookupColumn): number => c.datum?.bytes ?? Number.POSITIVE_INFINITY

/**
 * The columns of `columns` a lookup's B-tree entry holds, by their places in order, and its bytes, proved within
 * BTMaxItemSize in any order of them (`btreeEntry`), or the lookup's fault. Every column, where they fit; otherwise each
 * column the lookup binds by equality is left out, the widest first (`widthOf`), the first of two as wide, until the
 * rest fit: a column left out is a filter the lookup's reads apply beside the index, never a column of it, since no
 * index holds a column by an image of it. A column it reads in its order or matches a prefix of stays, which only an
 * index holding it serves: one of no byte bound is refused as unbounded, and an entry those still overfill names those
 * of them a byte bound or a precision would shrink, its varlenas (`orderedColumns`), or is refused for its bytes where
 * it holds none. A
 * lookup left no column is refused by the widest it binds, as unbounded or for its bytes.
 */
export const lookupEntry = (
	columns: NonEmptyReadonlyArray<LookupColumn>
): Result.Result<
	{ readonly held: NonEmptyReadonlyArray<number>; readonly bytes: BtreeEntryBytes },
	KeyFault
> => {
	const at = (i: number): LookupColumn => defined(columns[i], "a lookup column at its place")
	const entryOf = (held: ReadonlyArray<number>): ReadonlyArray<EntryColumn> =>
		held.flatMap((i) => {
			const c = at(i)
			return c.datum === undefined ? [] : [{ name: c.name, datum: c.datum, nullable: c.nullable }]
		})
	const fits = (held: ReadonlyArray<number>): boolean =>
		held.every((i) => at(i).datum !== undefined) &&
		btreeEntryBytes(entryOf(held)) <= btreeMaxItemSize
	let held: ReadonlyArray<number> = columns.map((_, i) => i)
	while (!fits(held)) {
		const [first, ...rest] = held.filter((i) => at(i).role === "equality")
		if (first === undefined) {
			break
		}
		const widest = rest.reduce((w, i) => (widthOf(at(i)) > widthOf(at(w)) ? i : w), first)
		held = held.filter((i) => i !== widest)
	}
	if (fits(held) && isNonEmpty(held)) {
		return Result.ok({ held, bytes: provedEntry(btreeEntryBytes(entryOf(held))) })
	}
	const blame = isNonEmpty(held)
		? held
		: [columns.reduce((w, c, i) => (widthOf(c) > widthOf(at(w)) ? i : w), 0)]
	const unbounded = blame.find((i) => at(i).datum === undefined)
	if (unbounded !== undefined) {
		return Result.err({ kind: "unboundedText", field: at(unbounded).name })
	}
	const entry = entryOf(blame)
	const bytes = btreeEntryBytes(entry)
	const ordered = blame.flatMap((i) => {
		const c = at(i)
		return c.role === "equality" || c.datum === undefined || isFixedWidth(c.datum)
			? []
			: [{ field: c.name, role: c.role, bytes: c.datum.bytes }]
	})
	return ordered.length === 0
		? Result.err({
				kind: "btreeEntry",
				bytes,
				limit: btreeMaxItemSize,
				datums: entry.map((c) => ({ field: c.name, bytes: c.datum.bytes }))
			})
		: Result.err({ kind: "orderedColumns", bytes, limit: btreeMaxItemSize, columns: ordered })
}

/** A text's varlena at no bytes: its four-byte header, aligned to 4. */
const textHeader = fixed(varlenaHeaderBytes, 4, "text")

/**
 * The most UTF-8 bytes a text's data takes beside the datums `others` in one B-tree entry, any order of them, its null
 * bitmap there where `nulls`: BTMaxItemSize less the entry over `others` and the text's own varlena at no bytes, each
 * datum at its worst alignment padding (btreeEntryBytes), and negative where that much alone passes it. textBytesBeside
 * sizes a key's text by it, and a fold refused for its running text names it as the most bytes a byte bound may admit
 * (laws/model/plan.ts, KeyFault `foldAccumulator`).
 */
export const textRoomBeside = (others: ReadonlyArray<DatumBound>, nulls: boolean): number =>
	alignDown(btreeMaxItemSize, maxAlign) -
	[...others, textHeader].reduce((offset, d) => afterAtWorst(offset, d), indexDataOffset(nulls))

/**
 * The most UTF-8 bytes a text can hold beside `others` in one B-tree entry whose other columns are exactly theirs, in
 * any order, any of them a law column that may be NULL: BTMaxItemSize less the entry over `others` and the text's own
 * varlena at no bytes, its data after the header and the null bitmap and each datum at its worst alignment padding,
 * which no order's or nullability's layout exceeds (btreeEntryBytes). So the text fits every index grizzle plans over
 * those columns: a declared key, a key over a selection, a containment's UNIQUE and index, a family's, a tree's and an
 * axis's UNIQUE, whose hidden law columns may hold NULL. A span key's GiST entry holds it too: each GiST key takes at
 * most twice its B-tree datum and fourteen bytes, so the at most INDEX_MAX_KEYS keys over one B-tree entry's datums fit
 * a GiST page. Its faults are the key's, every one: more columns than an index holds with the text, and each field of
 * no byte bound; or, where neither is, fields that leave the text no byte.
 */
export const textBytesBeside = (
	others: KeyFields
): Result.Result<number, NonEmptyReadonlyArray<KeyFault>> => {
	const each = others.map((f) => keyDatums([f]))
	const faults: ReadonlyArray<KeyFault> = [
		...(others.length + 1 > indexMaxKeys
			? [{ kind: "columns", limit: indexMaxKeys } as const]
			: []),
		...each.flatMap((d) => (d.ok ? [] : [d.error]))
	]
	if (isNonEmpty(faults)) {
		return Result.err(faults)
	}
	const bounded = each.flatMap((d) => (d.ok ? d.value : []))
	const room = textRoomBeside(
		bounded.map((d) => d.datum),
		true
	)
	return room < 0
		? Result.err([
				{
					kind: "btreeEntry",
					bytes: alignUp(alignDown(btreeMaxItemSize, maxAlign) - room, maxAlign),
					limit: btreeMaxItemSize,
					datums: [
						...bounded.map((d) => ({ field: d.field, bytes: d.datum.bytes })),
						{ field: "the text", bytes: textHeader.bytes }
					]
				}
			])
		: Result.ok(room)
}

/**
 * Key representability.
 *
 * Every primary key and candidate key must fit its index entry for every value its fields admit. The possible entry
 * size is derived conservatively from each field's type and refinement and the pinned build (blockSize, the default
 * block):
 *
 * - A B-tree entry is the IndexTupleData header (indexTupleHeader) plus each key datum, each aligned to its type's
 *   alignment, the whole MAXALIGNed (maxAlign); PostgreSQL refuses one above BTMaxItemSize (btreeMaxItemSize), and
 *   btreeEntryBytes bounds it in any order of its columns, so whether a key fits is a function of its column set.
 *   Fixed-width types have exact sizes, their typlens (typlens).
 *   A varlena datum is counted with its longest header (varlenaHeaderBytes), uncompressed: index_form_tuple may
 *   compress a large value, but no compression ratio is guaranteed. numeric(p, s) is at most numeric_maximum_size
 *   (numericMaximumSize), and a computed numeric, a derived relation's inferred field, and numeric of no typmod, at
 *   numeric's own limits, the same over its integer and fraction digits. Text is bounded by its pattern's language (the
 *   text analysis's bound), by a contract's charLength predicate, utf8EncodingMaxBytes per code point, and by a
 *   contract's octetLength predicate, exactly; the wildcard pattern has none, and a key over a text of no byte bound is
 *   refused (`unboundedText`). grizzle holds no key column by a digest of its own: a key that can outgrow its entry is
 *   refused, and its author bounds the field or keys by a digest the schema declares (docs/limits.md "Keys and indexes"). A
 *   vector(n) is its header and n reals (vectorHeaderBytes, pgvector's Vector struct), a
 *   key field like any other: every vector has one form, its components finite (pgvector refuses NaN and infinity)
 *   and its zero 0, so pgvector's equality is identity. A range is its header, its two bounds and its flags byte
 *   (rangeBytes).
 * - A span key, a key with one span field, lowers to PRIMARY KEY or UNIQUE (... span WITHOUT OVERLAPS), a GiST entry
 *   with the span last and every scalar component through btree_gist. Every key family has a btree_gist operator
 *   class, and the entry, with btree_gist's key representations (a fixed type stores its lower and
 *   upper bound, a varlena type both bounds as varlenas), must fit an empty GiST page less its one line pointer
 *   (gistMaxItemSize). A key with two span fields has no native lowering. The span key also
 *   gets a B-tree UNIQUE over the same columns as the insert protocol's arbiter, so it passes the B-tree
 *   check too.
 *
 * - Every index holds at most INDEX_MAX_KEYS columns (indexMaxKeys; `SHOW max_index_keys`). A key's PRIMARY KEY or
 *   UNIQUE index, and a span key's GiST constraint, has one column per key field, so a key of more fields has no
 *   index, whatever its entry size.
 *
 * Each datum is counted after its worst-case alignment padding, so the bound holds whatever the preceding values' sizes
 * and whatever order a key, a UNIQUE or a reference lists the columns in. A key that fails is UnrepresentableKey,
 * naming the key and the bound that failed, and the fix (core/causes.ts keyFaultText).
 *
 * The representability of one declared key, or its fault: its datums bounded, at most one span field, a span key's
 * scalar fields each of a family btree_gist indexes (no vector) and its GiST entry within a GiST page, and its B-tree
 * entry within PostgreSQL's limit.
 */
export const keyLayout = (fields: KeyFields): Result.Result<KeyLayout, KeyFault> => {
	const exact = exactKeyFields(fields)
	if (exact !== undefined) {
		return Result.err(exact)
	}
	const bounded = keyDatums(fields)
	if (!bounded.ok) {
		return bounded
	}
	const datums = bounded.value
	const spans = datums.filter((d) => isSpanDesc(d.desc))
	const [span, ...otherSpans] = spans
	if (otherSpans.length > 0) {
		return Result.err<KeyFault>({ kind: "spans", fields: spans.map((x) => x.field) })
	}
	const gist = span === undefined ? Result.ok(undefined) : spanKeyGist(datums, span)
	if (!gist.ok) {
		return gist
	}
	const btreeBytes = btreeEntry(keyColumns(datums))
	if (!btreeBytes.ok) {
		return btreeBytes
	}
	return Result.ok({
		fields: fields.map((f) => f.field),
		btreeBytes: btreeBytes.value,
		gist: gist.value
	})
}
