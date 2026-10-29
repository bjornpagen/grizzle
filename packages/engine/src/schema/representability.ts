import type { DatumUnbounded, KeyFault } from "#compiler/core/causes.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { ExprDesc, FieldDesc } from "#compiler/ir/desc.ts"
import { analyzeText, refinementBounds } from "#compiler/text/refinement.ts"

/** BTMaxItemSize for BLCKSZ 8192 (src/include/access/nbtree.h). */
export const btreeMaxItemSize = 2704
/** GiSTPageSize (8192 - 24 - 16) less one ItemIdData (src/backend/access/gist/gist.c, gistfitpage). */
export const gistMaxItemSize = 8148
/** INDEX_MAX_KEYS (src/include/pg_config_manual.h): the most columns one index holds. */
export const indexMaxKeys = 32
const indexTupleHeader = 8
const maxAlign = 8

const alignUp = (n: number, a: number): number => Math.ceil(n / a) * a

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
	| "enum"
	| "numeric"
	| "text"
	| "range"
	| "vector"

/**
 * The families a key field may have: every family but vector, whose float32 equality (-0 equal to 0) is no identity
 * a key rests on. They are also exactly the families btree_gist has an operator class for.
 */
type KeyFamily = Exclude<Family, "vector">
interface KeyDatum extends DatumBound {
	readonly family: KeyFamily
}

const fixed = (bytes: number, align: number, family: Family): DatumBound => ({
	bytes,
	align,
	family
})

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
			return Math.min(...predicate.args.map(charLengthBound))
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
		case "or":
		case "not":
		case "allen":
		case "pointIn":
		case "absent":
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

/**
 * The most UTF-8 bytes a text-valued descriptor admits: the pattern's bound, tightened by every contract's charLength
 * bound on the way down; Infinity when nothing bounds it.
 */
export const textByteBound = (desc: FieldDesc): number => {
	if (desc.kind === "text") {
		return patternByteBound(desc.source, desc.flags)
	}
	if (desc.kind === "contract") {
		return Math.min(
			textByteBound(desc.base),
			desc.predicate === undefined
				? Number.POSITIVE_INFINITY
				: Math.max(0, charLengthBound(desc.predicate)) * 4
		)
	}
	return Number.POSITIVE_INFINITY
}

const isTextDesc = (desc: FieldDesc): boolean =>
	desc.kind === "text" || (desc.kind === "contract" && isTextDesc(desc.base))

const integerFamily = (desc: FieldDesc): "int4" | "int8" | undefined => {
	switch (desc.kind) {
		case "contract":
			return integerFamily(desc.base)
		case "pg":
			return desc.type === "integer" ? "int4" : desc.type === "bigint" ? "int8" : undefined
		case "serial":
			return desc.type === "serial" ? "int4" : desc.type === "bigserial" ? "int8" : undefined
		case "numeric":
		case "uuid":
		case "text":
		case "span":
		case "closedId":
		case "vector":
			return undefined
	}
}

/** The largest index datum of a PostgreSQL scalar type: each is fixed-size. */
const pgDatumBound = (
	type: Extract<FieldDesc, { readonly kind: "pg" }>["type"]
): Result.Result<DatumBound, DatumUnbounded> => {
	switch (type) {
		case "smallint":
			return Result.ok(fixed(2, 2, "int2"))
		case "integer":
			return Result.ok(fixed(4, 4, "int4"))
		case "bigint":
			return Result.ok(fixed(8, 8, "int8"))
		case "real":
			return Result.ok(fixed(4, 4, "float4"))
		case "double precision":
			return Result.ok(fixed(8, 8, "float8"))
		case "money":
			return Result.ok(fixed(8, 8, "money"))
		case "boolean":
			return Result.ok(fixed(1, 1, "bool"))
	}
}

/** The largest index datum of a field, or why it has none. */
export const datumBound = (desc: FieldDesc): Result.Result<DatumBound, DatumUnbounded> => {
	switch (desc.kind) {
		case "contract":
			if (isTextDesc(desc)) {
				break
			}
			return datumBound(desc.base)
		case "pg":
			return pgDatumBound(desc.type)
		case "serial":
			return Result.ok(
				desc.type === "smallserial"
					? fixed(2, 2, "int2")
					: desc.type === "serial"
						? fixed(4, 4, "int4")
						: fixed(8, 8, "int8")
			)
		case "uuid":
			return Result.ok(fixed(16, 1, "uuid"))
		case "closedId":
			return Result.ok(fixed(4, 4, "enum"))
		case "numeric":
			if (!("precision" in desc)) {
				return Result.err("numericPrecision")
			}
			return Result.ok(fixed(8 + 2 * Math.floor((desc.precision + 6) / 4), 4, "numeric"))
		case "span":
			return Result.ok(
				integerFamily(desc.endpoint) === "int4" ? fixed(17, 4, "range") : fixed(25, 8, "range")
			)
		case "vector":
			return Result.ok(fixed(8 + 4 * desc.dimensions, 4, "vector"))
		case "text":
			break
	}
	const bytes = textByteBound(desc)
	if (!Number.isFinite(bytes)) {
		return Result.err("textBytes")
	}
	return Result.ok(fixed(4 + bytes, 4, "text"))
}

/** The most bytes a B-tree tuple over these datums can reach. */
export const btreeEntryBytes = (datums: ReadonlyArray<DatumBound>): number => {
	let size = indexTupleHeader
	for (const d of datums) {
		size += d.align - 1 + d.bytes
	}
	return alignUp(size, maxAlign)
}

/**
 * btree_gist's key representation of a scalar datum (contrib/btree_gist): a fixed type stores its lower and upper
 * bound side by side; numeric and text store both bounds as varlenas in one varlena (btree_utils_var.c). A range is
 * its own key under range_ops.
 */
const gistKeyBytes = (d: KeyDatum): number => {
	switch (d.family) {
		case "int2":
			return 4
		case "int4":
		case "float4":
		case "enum":
			return 8
		case "int8":
		case "float8":
		case "money":
			return 16
		case "bool":
			return 2
		case "uuid":
			return 32
		case "numeric":
		case "text":
			return 4 + alignUp(d.bytes, 4) + d.bytes
		case "range":
			return d.bytes
	}
}

/** The most bytes a GiST tuple over these key datums can reach. */
const keyGistEntryBytes = (datums: ReadonlyArray<KeyDatum>): number => {
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
	const keys: Array<KeyDatum> = []
	for (const { field, datum } of fields) {
		if (datum.family === "vector") {
			return Result.err(field)
		}
		keys.push({ bytes: datum.bytes, align: datum.align, family: datum.family })
	}
	return Result.ok(keyGistEntryBytes(keys))
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

const isSpanDesc = (desc: FieldDesc): boolean =>
	desc.kind === "span" || (desc.kind === "contract" && isSpanDesc(desc.base))

/** A key's fields with their descriptors, each a field of the keyed relation. */
export type KeyFields = ReadonlyArray<{ readonly field: string; readonly desc: FieldDesc }>

/**
 * The bounded datums of a key's fields, or why the key has none: more columns than one index holds, or a field whose
 * datum has no bound. The rule every key's index entry starts from, a declared key's (keyLayout) and an inherited
 * one's (analysis/derived/keys.ts derivedKeyLayout).
 */
export const keyDatums = (
	fields: KeyFields
): Result.Result<
	ReadonlyArray<{ readonly field: string; readonly desc: FieldDesc; readonly datum: DatumBound }>,
	KeyFault
> => {
	if (fields.length > indexMaxKeys) {
		return Result.err({ kind: "columns", limit: indexMaxKeys })
	}
	const out: Array<{
		readonly field: string
		readonly desc: FieldDesc
		readonly datum: DatumBound
	}> = []
	for (const { field, desc } of fields) {
		const bound = datumBound(desc)
		if (!bound.ok) {
			return Result.err({ kind: "unbounded", field, datum: bound.error })
		}
		out.push({ field, desc, datum: bound.value })
	}
	return Result.ok(out)
}

/** A B-tree entry over `datums`, or the fault of one above PostgreSQL's limit. */
export const btreeEntry = (datums: ReadonlyArray<DatumBound>): Result.Result<number, KeyFault> => {
	const bytes = btreeEntryBytes(datums)
	return bytes > btreeMaxItemSize
		? Result.err({ kind: "btreeEntry", bytes, limit: btreeMaxItemSize })
		: Result.ok(bytes)
}

/**
 * Key representability.
 *
 * Every primary key and candidate key must fit its index entry for every value its fields admit. The possible entry
 * size is derived conservatively from each field's type and refinement and the pinned build (the default
 * 8192-byte block):
 *
 * - A B-tree entry is the 8-byte IndexTupleData header plus each key datum, each aligned to its type's alignment, the
 *   whole MAXALIGNed; PostgreSQL refuses one above BTMaxItemSize, 2704 bytes (nbtree.h). Fixed-width types have exact
 *   sizes. A varlena datum is counted with its 4-byte header, uncompressed: index_form_tuple may compress a large
 *   value, but no compression ratio is guaranteed. numeric(p, s) is at most numeric_maximum_size, 8 + 2 *
 *   floor((p + 6) / 4) bytes (numeric.c); numeric without a precision has no bound. Text is bounded by its pattern's
 *   language (the text analysis's bound) and by a contract's charLength predicate, four bytes per code point; the
 *   wildcard pattern has none. A vector(n) is 8 + 4n bytes (pgvector's Vector struct). A vector field is
 *   never a key field: float32 equality is no key identity. Ranges are 17 (int4range) and 25 (int8range) bytes.
 * - A span key, a key with one span field, lowers to PRIMARY KEY or UNIQUE (... span WITHOUT OVERLAPS), a GiST entry
 *   with the span last and every scalar component through btree_gist. Every key family has a btree_gist operator
 *   class, and the entry, with btree_gist's key representations (a fixed type stores its lower and
 *   upper bound, a varlena type both bounds as varlenas), must fit an empty GiST page: GiSTPageSize, 8152 bytes, less
 *   one 4-byte line pointer (gist.c gistSplit). A key with two span fields has no native lowering. The span key also
 *   gets a B-tree UNIQUE over the same columns as the insert protocol's arbiter, so it passes the B-tree
 *   check too.
 *
 * - Every index holds at most INDEX_MAX_KEYS columns, 32 in the pinned build (pg_config_manual.h; `SHOW
 *   max_index_keys`). A key's PRIMARY KEY or UNIQUE index, and a span key's GiST constraint, has one column per key
 *   field, so a key of more than 32 fields has no index, whatever its entry size.
 *
 * The worst-case alignment padding before each datum is counted, so the bound holds whatever the preceding values'
 * actual sizes. A key that fails is UnrepresentableKey, naming the key and the bound that failed.
 *
 * The representability of one declared key, or its fault: its datums bounded, no vector field, at most one span field,
 * a span key's GiST entry within a GiST page, and its B-tree entry within PostgreSQL's limit.
 */
export const keyLayout = (fields: KeyFields): Result.Result<KeyLayout, KeyFault> => {
	const bounded = keyDatums(fields)
	if (!bounded.ok) {
		return bounded
	}
	const datums = bounded.value
	const columns: Array<{ readonly field: string; readonly datum: KeyDatum }> = []
	const spans: Array<{ readonly field: string; readonly datum: KeyDatum }> = []
	for (const { field, desc, datum: d } of datums) {
		if (d.family === "vector") {
			return Result.err<KeyFault>({ kind: "vector", field })
		}
		const datum: KeyDatum = { bytes: d.bytes, align: d.align, family: d.family }
		columns.push({ field, datum })
		if (isSpanDesc(desc)) {
			spans.push({ field, datum })
		}
	}
	const [span, ...otherSpans] = spans
	if (otherSpans.length > 0) {
		return Result.err<KeyFault>({ kind: "spans", fields: spans.map((x) => x.field) })
	}
	const gistLayout =
		span === undefined
			? undefined
			: {
					span: span.field,
					bytes: keyGistEntryBytes([
						...columns.filter((c) => c.field !== span.field).map((c) => c.datum),
						span.datum
					])
				}
	if (gistLayout !== undefined && gistLayout.bytes > gistMaxItemSize) {
		return Result.err<KeyFault>({
			kind: "gistEntry",
			bytes: gistLayout.bytes,
			limit: gistMaxItemSize
		})
	}
	const btreeBytes = btreeEntry(datums.map((x) => x.datum))
	if (!btreeBytes.ok) {
		return btreeBytes
	}
	return Result.ok({
		fields: fields.map((f) => f.field),
		btreeBytes: btreeBytes.value,
		gist: gistLayout
	})
}
