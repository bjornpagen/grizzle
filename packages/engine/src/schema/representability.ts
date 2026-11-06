import type { KeyFault } from "#compiler/core/causes.ts"
import {
	alignUp,
	blockSize,
	derived,
	itemIdBytes,
	type Limit,
	maxAlign,
	pageHeaderBytes,
	postgresSource,
	published,
	rosterMaxCodes,
	typlens
} from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { ExprDesc, FieldDesc, InferredFieldDesc } from "#compiler/ir/desc.ts"
import { decDigits } from "#compiler/scalar/compute/numeric.ts"
import { analyzeText, refinementBounds } from "#compiler/text/refinement.ts"

/** A tuple identifier, ItemPointerData. */
const itemPointerBytes: Limit = published({
	value: 6,
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "the heap tuple identifier an index tuple and a B-tree pivot carry",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/storage/itemptr.h#L30-L31`,
	quote: "The struct is designed to be six bytes long (it contains three int16 fields)",
	verified: "2026-11-05"
})

/** An index tuple's header, IndexTupleData: its heap tuple identifier and its two-byte t_info. */
const indexTupleHeader: Limit = published({
	value: 8,
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "the header of every B-tree and GiST index tuple",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/access/itup.h#L35-L51`,
	quote:
		"typedef struct IndexTupleData { ItemPointerData t_tid; unsigned short t_info; } IndexTupleData;",
	verified: "2026-11-05"
})

/** A B-tree page's special space, BTPageOpaqueData: two block numbers, a level, flags and a cycle id. */
const btreeOpaqueBytes: Limit = published({
	value: 16,
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "the special space of every B-tree page",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/access/nbtree.h#L63-L70`,
	quote:
		"typedef struct BTPageOpaqueData { BlockNumber btpo_prev; BlockNumber btpo_next; uint32 btpo_level; uint16 btpo_flags; BTCycleId btpo_cycleid; } BTPageOpaqueData;",
	verified: "2026-11-05"
})

/** A GiST page's special space, GISTPageOpaqueData: an LSN, a block number, flags and the page id. */
const gistOpaqueBytes: Limit = published({
	value: 16,
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "the special space of every GiST page",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/access/gist.h#L80-L86`,
	quote:
		"typedef struct GISTPageOpaqueData { PageGistNSN nsn; BlockNumber rightlink; uint16 flags; uint16 gist_page_id; } GISTPageOpaqueData;",
	verified: "2026-11-05"
})

/**
 * A varlena's header, VARHDRSZ: the length every variable-length datum leads with, at its longest, sizeof(int32), C's
 * int32_t ("typedef int32_t int32;", c.h).
 */
const varlenaHeaderBytes: Limit = published({
	value: 4,
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope:
		"the header of one variable-length datum, uncompressed and in line: a numeric, a text, a range, a vector",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/c.h#L787`,
	quote: "#define VARHDRSZ\t\t((int32) sizeof(int32))",
	verified: "2026-11-05"
})

/**
 * The bits one byte of a bit string holds, BITS_PER_BYTE.
 *
 * @formatConstant a bit string's byte: 8 bits
 */
const bitsPerByte = 8

/**
 * The most bytes one set over a roster takes, uncompressed and in line: a bit(n) varlena of its header, its bit count
 * and a byte per eight bits, n its roster's codes. A roster's codes are installation data, which ownership does not
 * hold, so the bound is the one every installation's roster keeps within: its most codes.
 */
const bitsBytes: Limit = derived({
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "one set over a roster, its bit(n) datum",
	from: [varlenaHeaderBytes, typlens.int4, rosterMaxCodes],
	derivation: `VARBITTOTALLEN(n), "#define VARBITTOTALLEN(BITLEN) (((BITLEN) + BITS_PER_BYTE-1)/BITS_PER_BYTE + VARHDRSZ + VARBITHDRSZ)" with VARBITHDRSZ sizeof(int32) (${postgresSource}/src/include/utils/varbit.h), at n the most codes a roster numbers`,
	compute: ([header, bitLength, codes]) =>
		header.value + bitLength.value + Math.ceil(codes.value / bitsPerByte)
})

/** The two bounds a range holds, and a btree_gist key of a fixed-size type beside each other. */
const bounds = ["lower", "upper"] as const

/** A range's header, sizeof(RangeType): its varlena header and its range type's OID, which its bounds follow. */
const rangeHeaderBytes: Limit = derived({
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "the header of one range datum",
	from: [varlenaHeaderBytes, typlens.oid],
	derivation: `sizeof(RangeType), "typedef struct { int32 vl_len_; Oid rangetypid; /* Following the OID are zero to two bound values, then a flags byte */ } RangeType;" (${postgresSource}/src/include/utils/rangetypes.h#L25-L30), which range_serialize counts first: VARHDRSZ and an oid`,
	compute: ([header, oid]) => header.value + oid.value
})

/** A range's flags byte, after its bounds. */
const rangeFlagBytes: Limit = published({
	value: 1,
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "the flags of one range datum",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/backend/utils/adt/rangetypes.c#L2049-L2050`,
	quote: "/* Add space for flag byte */ msize += sizeof(char);",
	verified: "2026-11-05"
})

/** A numeric's header, NUMERIC_HDRSZ: its varlena header, its sign and display scale, and its weight. */
const numericHeaderBytes: Limit = derived({
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "the long header of one numeric datum, the longest it takes",
	from: [varlenaHeaderBytes, typlens.int2],
	derivation: `"#define NUMERIC_HDRSZ\t(VARHDRSZ + sizeof(uint16) + sizeof(int16))" (${postgresSource}/src/backend/utils/adt/numeric.c#L178): VARHDRSZ and two 16-bit fields, each a smallint's width`,
	compute: ([header, int16]) => header.value + int16.value * 2
})

/** A numeric's NBASE digit, NumericDigit, an int16. */
const numericDigitBytes: Limit = derived({
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "one NBASE digit of a numeric datum",
	from: [typlens.int2],
	derivation: `"typedef int16 NumericDigit;" (${postgresSource}/src/backend/utils/adt/numeric.c#L103), a smallint's width`,
	compute: ([int16]) => int16.value
})

const pgvectorSource = "https://github.com/pgvector/pgvector/blob/v0.8.7/src/vector.h"

/** A vector's header, offsetof(Vector, x): its varlena header, its dimension count and a reserved field. */
const vectorHeaderBytes: Limit = derived({
	owner: "pgvector 0.8.7",
	unit: "bytes",
	scope: "the header of one vector datum, which its components follow",
	from: [varlenaHeaderBytes, typlens.int2],
	derivation: `offsetof(Vector, x) in VECTOR_SIZE, "#define VECTOR_SIZE(_dim)\t\tadd_size(offsetof(Vector, x), mul_size(sizeof(float), _dim))" (${pgvectorSource}#L13), of "typedef struct Vector { int32 vl_len_; int16 dim; int16 unused; float x[FLEXIBLE_ARRAY_MEMBER]; } Vector;" (${pgvectorSource}#L18-L24): VARHDRSZ and two int16 fields, each a smallint's width; each component a C float, a real ("typedef float float4;", c.h)`,
	compute: ([header, int16]) => header.value + int16.value * 2
})

const alignDown = (n: number, a: number): number => Math.floor(n / a) * a

/** The most bytes one B-tree entry takes: BTMaxItemSize, a third of a page, its pivot's heap tuple identifier left. */
export const btreeMaxItemSize: Limit = derived({
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "one B-tree index entry, a key's index's among them",
	from: [blockSize, maxAlign, pageHeaderBytes, itemIdBytes, btreeOpaqueBytes, itemPointerBytes],
	derivation: `nbtree.h's BTMaxItemSize: MAXALIGN_DOWN((BLCKSZ - MAXALIGN(SizeOfPageHeaderData + 3*sizeof(ItemIdData)) - MAXALIGN(sizeof(BTPageOpaqueData))) / 3) - MAXALIGN(sizeof(ItemPointerData)) (${postgresSource}/src/include/access/nbtree.h#L165-L169), three entries to a page`,
	compute: ([block, align, header, itemId, opaque, pointer]) =>
		alignDown(
			(block.value -
				alignUp(header.value + 3 * itemId.value, align.value) -
				alignUp(opaque.value, align.value)) /
				3,
			align.value
		) - alignUp(pointer.value, align.value)
})

/** The most bytes one GiST entry takes: an empty page, GiSTPageSize, less its one line pointer. */
export const gistMaxItemSize: Limit = derived({
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "one GiST index entry, a span key's among them",
	from: [blockSize, maxAlign, pageHeaderBytes, gistOpaqueBytes, itemIdBytes],
	derivation: `gist_private.h's GiSTPageSize, BLCKSZ - SizeOfPageHeaderData - MAXALIGN(sizeof(GISTPageOpaqueData)) (${postgresSource}/src/include/access/gist_private.h#L474-L475), less the entry's one ItemIdData, as gistfitpage counts it`,
	compute: ([block, align, header, opaque, itemId]) =>
		block.value - header.value - alignUp(opaque.value, align.value) - itemId.value
})

/** The most columns one index holds, INDEX_MAX_KEYS: a key's index has one per field. */
export const indexMaxKeys: Limit = published({
	value: 32,
	owner: "PostgreSQL 19rc1",
	unit: "columns",
	scope: "one index: a key's, a span key's GiST constraint, an access path's",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/pg_config_manual.h#L79`,
	quote: "#define INDEX_MAX_KEYS\t\t32",
	verified: "2026-11-05"
})

export interface DatumBound {
	/** The most bytes the datum occupies in an index tuple, its header included. */
	readonly bytes: number
	/** Its type's alignment in bytes. */
	readonly align: number
	/** The B-tree carrier family, which btree_gist's support and key representation depend on. */
	readonly family: Family
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
	| "code"
	| "bit"
	| "numeric"
	| "text"
	| "range"
	| "vector"

/** The families btree_gist has an operator class for: every family but vector, the scalars a span key may hold. */
type GistFamily = Exclude<Family, "vector">
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
	fixed(varlenaHeaderBytes.value + typlens.int4.value + Math.ceil(codes / bitsPerByte), 4, "bit")

/** The literal value of a charLength bound operand. */
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

const isCharLengthOfValue = (e: ExprDesc): boolean =>
	e.kind === "compute" &&
	e.fn === "charLength" &&
	e.args.length === 1 &&
	e.args[0]?.kind === "value"

/**
 * The upper bound in code points that a contract predicate puts on its value's char_length:
 * charLength(v) <= n, < n, = n, between(charLength(v), lo, hi), in [...], their mirror images, and conjunctions.
 * Infinity, the top of the bounds' min order, when the predicate bounds no length.
 */
export const charLengthBound = (predicate: ExprDesc): number => {
	switch (predicate.kind) {
		case "and":
			return predicate.args.reduce(
				(bound, arg) => Math.min(bound, charLengthBound(arg)),
				Number.POSITIVE_INFINITY
			)
		case "compare": {
			const { op, left, right } = predicate
			if (isCharLengthOfValue(left)) {
				const n = literalCount(right)
				if (n === undefined) {
					return Number.POSITIVE_INFINITY
				}
				return op === "le" || op === "eq" ? n : op === "lt" ? n - 1 : Number.POSITIVE_INFINITY
			}
			if (isCharLengthOfValue(right)) {
				const n = literalCount(left)
				if (n === undefined) {
					return Number.POSITIVE_INFINITY
				}
				return op === "ge" || op === "eq" ? n : op === "gt" ? n - 1 : Number.POSITIVE_INFINITY
			}
			return Number.POSITIVE_INFINITY
		}
		case "between": {
			if (!isCharLengthOfValue(predicate.arg)) {
				return Number.POSITIVE_INFINITY
			}
			return literalCount(predicate.high) ?? Number.POSITIVE_INFINITY
		}
		case "in": {
			if (!isCharLengthOfValue(predicate.arg)) {
				return Number.POSITIVE_INFINITY
			}
			let max = -1
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
		case "base":
		case "cond":
		case "when":
		case "or":
		case "not":
		case "allen":
		case "pointIn":
		case "absent":
		case "closedAt":
		case "closedRow":
			return Number.POSITIVE_INFINITY
	}
}

/**
 * A pattern's byte bound, the text analysis's (text/refinement.ts), which reads the pattern's language through its
 * normalized IR, never its spelling: exact from the minimal DFA, structural above its bound. A pattern the analysis
 * refuses bounds nothing here; the refusal itself is the analysis's to report at compilation.
 */
const patternLoc = SourceLoc("key representability", [])
const patternByteBound = (source: string, flags: "u" | "su"): number => {
	const analyzed = analyzeText(source, flags, patternLoc)
	return (
		(analyzed.ok ? refinementBounds(analyzed.value)?.bytes : undefined) ?? Number.POSITIVE_INFINITY
	)
}

/** The most bytes UTF-8 encodes one code point in: UTF8 is the server encoding admission requires of a database. */
const utf8MaxBytes: Limit = published({
	value: 4,
	owner: "RFC 3629, UTF-8",
	unit: "bytes per code point",
	scope: "the UTF-8 encoding of one code point of a text value",
	constraint: "protocol constant",
	source: "https://www.rfc-editor.org/rfc/rfc3629#section-3",
	quote:
		"In UTF-8, characters from the U+0000..U+10FFFF range (the UTF-16 accessible range) are encoded using sequences of 1 to 4 octets.",
	verified: "2026-11-05"
})

/**
 * The most UTF-8 bytes a text-valued descriptor admits, declared or inferred: the pattern's bound, tightened by every
 * contract's charLength bound on the way down, utf8MaxBytes a code point; Infinity when nothing bounds it.
 */
export const textByteBound = (desc: InferredFieldDesc): number => {
	if (desc.kind === "text") {
		return patternByteBound(desc.source, desc.flags)
	}
	if (desc.kind === "contract") {
		return Math.min(
			textByteBound(desc.base),
			desc.predicate === undefined
				? Number.POSITIVE_INFINITY
				: Math.max(0, charLengthBound(desc.predicate)) * utf8MaxBytes.value
		)
	}
	return Number.POSITIVE_INFINITY
}

const isTextDesc = (desc: InferredFieldDesc): boolean =>
	desc.kind === "text" || (desc.kind === "contract" && isTextDesc(desc.base))

const integerFamily = (desc: FieldDesc): "int4" | "int8" | undefined => {
	switch (desc.kind) {
		case "contract":
			return integerFamily(desc.base)
		case "pg":
			return desc.type === "integer" ? "int4" : desc.type === "bigint" ? "int8" : undefined
		case "numeric":
		case "uuid":
		case "text":
		case "span":
		case "closedId":
		case "bits":
		case "vector":
			return undefined
	}
}

/** The largest index datum of a PostgreSQL scalar type: each is fixed-size. */
const pgDatumBound = (type: Extract<FieldDesc, { readonly kind: "pg" }>["type"]): DatumBound => {
	switch (type) {
		case "smallint":
			return fixed(typlens.int2.value, 2, "int2")
		case "integer":
			return fixed(typlens.int4.value, 4, "int4")
		case "bigint":
			return fixed(typlens.int8.value, 8, "int8")
		case "real":
			return fixed(typlens.float4.value, 4, "float4")
		case "double precision":
			return fixed(typlens.float8.value, 8, "float8")
		case "money":
			return fixed(typlens.money.value, 8, "money")
		case "boolean":
			return fixed(typlens.bool.value, 1, "bool")
		case "date":
			return fixed(typlens.date.value, 4, "date")
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
	numericHeaderBytes.value +
	numericDigitBytes.value * Math.floor((precision + 2 * (decDigits.value - 1)) / decDigits.value)

/**
 * range_serialize's size of a range over an endpoint of `endpoint` bytes, both bounds present: its header, which is
 * MAXALIGNed, its two bounds, each at its own width's alignment and so unpadded, and its flags byte.
 */
const rangeBytes = (endpoint: Limit): number =>
	rangeHeaderBytes.value + bounds.length * endpoint.value + rangeFlagBytes.value

/** The largest index datum of a field, declared or inferred; undefined for text whose pattern proves no byte bound. */
export const datumBound = (desc: InferredFieldDesc): DatumBound | undefined => {
	switch (desc.kind) {
		case "contract":
			if (isTextDesc(desc)) {
				break
			}
			return datumBound(desc.base)
		case "pg":
			return pgDatumBound(desc.type)
		case "uuid":
			return fixed(typlens.uuid.value, 1, "uuid")
		case "closedId":
			return fixed(typlens.int2.value, 2, "code")
		case "bits":
			return fixed(bitsBytes.value, 4, "bit")
		case "numeric":
			return fixed(numericMaximumSize(desc.precision), 4, "numeric")
		case "computedNumeric":
			return fixed(numericMaximumSize(desc.bound.digits + desc.bound.scale), 4, "numeric")
		case "span":
			return integerFamily(desc.endpoint) === "int4"
				? fixed(rangeBytes(typlens.int4), 4, "range")
				: fixed(rangeBytes(typlens.int8), 8, "range")
		case "vector":
			return fixed(vectorHeaderBytes.value + typlens.float4.value * desc.dimensions, 4, "vector")
		case "text":
			break
	}
	const bytes = textByteBound(desc)
	return Number.isFinite(bytes) ? fixed(varlenaHeaderBytes.value + bytes, 4, "text") : undefined
}

/** The most bytes a B-tree tuple over these datums can reach. */
export const btreeEntryBytes = (datums: ReadonlyArray<DatumBound>): number => {
	let size = indexTupleHeader.value
	for (const d of datums) {
		size += d.align - 1 + d.bytes
	}
	return alignUp(size, maxAlign.value)
}

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
		case "numeric":
		case "text":
		case "bit":
			return varlenaHeaderBytes.value + alignUp(d.bytes, 4) + d.bytes
		case "range":
			return d.bytes
	}
}

/** The most bytes a GiST tuple over these key datums can reach. */
const keyGistEntryBytes = (datums: ReadonlyArray<GistDatum>): number => {
	let size = indexTupleHeader.value
	for (const d of datums) {
		size += maxAlign.value - 1 + gistKeyBytes(d)
	}
	return alignUp(size, maxAlign.value)
}

/** The most bytes a GiST tuple over these fields' datums can reach, or the first field btree_gist cannot index. */
export const gistEntryBytes = (
	fields: ReadonlyArray<{ readonly field: string; readonly datum: DatumBound }>
): Result.Result<number, string> => {
	const keys: Array<GistDatum> = []
	for (const { field, datum } of fields) {
		if (datum.family === "vector") {
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
): Result.Result<{ readonly span: string; readonly bytes: number }, KeyFault> => {
	const bytes = gistEntryBytes([...datums.filter((d) => d.field !== span.field), span])
	if (!bytes.ok) {
		return Result.err({ kind: "gistOperatorClass", field: bytes.error })
	}
	return bytes.value > gistMaxItemSize.value
		? Result.err({ kind: "gistEntry", bytes: bytes.value, limit: gistMaxItemSize.value })
		: Result.ok({ span: span.field, bytes: bytes.value })
}

export interface KeyLayout {
	readonly fields: ReadonlyArray<string>
	readonly btreeBytes: number
	/**
	 * A span key's GiST layout: its span field, placed last in its WITHOUT OVERLAPS constraint, and the most bytes its
	 * GiST entry can reach. A key without a span field has none.
	 */
	readonly gist: { readonly span: string; readonly bytes: number } | undefined
}

const isSpanDesc = (desc: InferredFieldDesc): boolean =>
	desc.kind === "span" || (desc.kind === "contract" && isSpanDesc(desc.base))

/**
 * A key's fields with their descriptors, each a field of the keyed relation: a declared key's, or a derived relation's
 * inherited one's, whose fields are inferred.
 */
export type KeyFields = ReadonlyArray<{
	readonly field: string
	readonly desc: InferredFieldDesc
}>

/**
 * The bounded datums of a key's fields, or why the key has none: more columns than one index holds, or a field whose
 * datum has no bound. The rule every key's index entry starts from, a declared key's (keyLayout) and an inherited
 * one's (analysis/derived/keys.ts derivedKeyLayout).
 */
export const keyDatums = (
	fields: KeyFields
): Result.Result<
	ReadonlyArray<{
		readonly field: string
		readonly desc: InferredFieldDesc
		readonly datum: DatumBound
	}>,
	KeyFault
> => {
	if (fields.length > indexMaxKeys.value) {
		return Result.err({ kind: "columns", limit: indexMaxKeys.value })
	}
	const out: Array<{
		readonly field: string
		readonly desc: InferredFieldDesc
		readonly datum: DatumBound
	}> = []
	for (const { field, desc } of fields) {
		const bound = datumBound(desc)
		if (bound === undefined) {
			return Result.err({ kind: "unboundedText", field })
		}
		out.push({ field, desc, datum: bound })
	}
	return Result.ok(out)
}

/** A B-tree entry over `datums`, or the fault of one above PostgreSQL's limit. */
export const btreeEntry = (datums: ReadonlyArray<DatumBound>): Result.Result<number, KeyFault> => {
	const bytes = btreeEntryBytes(datums)
	return bytes > btreeMaxItemSize.value
		? Result.err({ kind: "btreeEntry", bytes, limit: btreeMaxItemSize.value })
		: Result.ok(bytes)
}

/**
 * Key representability.
 *
 * Every primary key and candidate key must fit its index entry for every value its fields admit. The possible entry
 * size is derived conservatively from each field's type and refinement and the pinned build (blockSize, the default
 * block):
 *
 * - A B-tree entry is the IndexTupleData header (indexTupleHeader) plus each key datum, each aligned to its type's
 *   alignment, the whole MAXALIGNed (maxAlign); PostgreSQL refuses one above BTMaxItemSize (btreeMaxItemSize).
 *   Fixed-width types have exact sizes, their typlens (typlens). A varlena datum is counted with its longest header
 *   (varlenaHeaderBytes), uncompressed: index_form_tuple may compress a large value, but no compression ratio is
 *   guaranteed. numeric(p, s) is at most numeric_maximum_size (numericMaximumSize), and a computed numeric, a derived
 *   relation's inferred field, the same over its integer and fraction digits. Text is bounded by its pattern's
 *   language (the text analysis's bound) and by a contract's charLength predicate, utf8MaxBytes per code point; the
 *   wildcard pattern has none. A vector(n) is its header and n reals (vectorHeaderBytes, pgvector's Vector struct), a
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
 * The worst-case alignment padding before each datum is counted, so the bound holds whatever the preceding values'
 * actual sizes. A key that fails is UnrepresentableKey, naming the key and the bound that failed.
 *
 * The representability of one declared key, or its fault: its datums bounded, at most one span field, a span key's
 * scalar fields each of a family btree_gist indexes (no vector) and its GiST entry within a GiST page, and its B-tree
 * entry within PostgreSQL's limit.
 */
export const keyLayout = (fields: KeyFields): Result.Result<KeyLayout, KeyFault> => {
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
	const btreeBytes = btreeEntry(datums.map((x) => x.datum))
	if (!btreeBytes.ok) {
		return btreeBytes
	}
	return Result.ok({
		fields: fields.map((f) => f.field),
		btreeBytes: btreeBytes.value,
		gist: gist.value
	})
}
