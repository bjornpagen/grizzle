/**
 * The cells encoder: the one encoding of a closed relation as a string of cells, which every constant, domain and
 * lookup of a closed relation reads.
 *
 * A closed relation has no extent in the database. Its rows erase to one bit string, read `width` bits at a time:
 * - every field has a code space: a closed id's is its roster's codes, holes included, and an open-typed field's is its
 *   active domain in the relation, in sorted order;
 * - the key's codes index the string in mixed radix, row-major in the key's declared order, so the string holds one
 *   cell per point of the key's space; a key whose fields after an owner prefix hold slots of `fin(O, n)`, O a closed
 *   relation over that prefix, is a dependent sum instead, each owner's block of the mixed radix at its own counts
 *   after every earlier owner's (KeySpace), so a dependent coordinate stays dense;
 * - a cell is 0 where the relation holds no row and 1 + c where it does, c the payload's mixed-radix code, and its width
 *   is ⌈log₂(1 + |payload space|)⌉, so a relation with no payload, a set, has cells of one bit.
 *
 * Sizes, indexes and payload codes are bigints, exact over any space. A bound on them is the caller's.
 */
import { everyProperty } from "#compiler/core/canonical.ts"
import { type ConstantDigest, constantDigest } from "#compiler/core/fingerprint.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { type Comparator, compareStrings } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"

/** One code of a roster: the live handle it names, or the hole a removed handle left, which no handle takes again. */
export type CodeSlot =
	| { readonly kind: "live"; readonly handle: string }
	| { readonly kind: "hole" }

/**
 * A roster's codes, code c at position c. Codes are append-only, so the length counts every code the roster has ever
 * minted, and it is the roster's code space: a closed id indexes by it and a set over the roster has one bit per code,
 * holes included. A roster not yet installed has no codes.
 */
export type RosterCodes = ReadonlyArray<CodeSlot>

/** Two handles declared out of their codes' order: `earlier` is declared first, yet `later` holds the lower code. */
export interface Reordered {
	readonly earlier: string
	readonly later: string
}

/** A declared handle and the code it holds. */
interface Claim {
	readonly handle: string
	readonly code: number
}

/**
 * A roster's codes after a declaration, from its previous codes, the renames declared for it (old handle to new) and
 * its handles in declared order.
 *
 * Each declared handle stands for a previous handle: the one a rename names it from, or else itself unless a rename
 * moves it away. It keeps that handle's live code, so a code never changes meaning; a handle with none takes the next
 * code past every code minted before. Every code no declared handle keeps is a hole, and a hole stays one.
 *
 * A roster's comparison order is its codes' order, so a handle declared after another must hold a later code: new
 * handles append. A declaration that puts two handles out of their codes' order is refused with the first such pair.
 */
export const rosterCodes = (
	previous: RosterCodes,
	renames: ReadonlyMap<string, string>,
	handles: NonEmptyReadonlyArray<string>
): Result.Result<RosterCodes, Reordered> => {
	const liveCode = new Map<string, number>()
	for (const [code, slot] of previous.entries()) {
		if (slot.kind === "live") {
			liveCode.set(slot.handle, code)
		}
	}
	const renamedFrom = new Map(Array.from(renames, ([from, to]) => [to, from]))
	const keptCode = (handle: string): number | undefined => {
		const from = renamedFrom.get(handle)
		if (from !== undefined) {
			return liveCode.get(from)
		}
		return renames.has(handle) ? undefined : liveCode.get(handle)
	}
	const claims: Array<Claim> = []
	let minted = previous.length
	for (const handle of handles) {
		const kept = keptCode(handle)
		if (kept === undefined) {
			claims.push({ handle, code: minted })
			minted += 1
		} else {
			claims.push({ handle, code: kept })
		}
	}
	let before: Claim | undefined
	for (const claim of claims) {
		if (before !== undefined && claim.code < before.code) {
			return Result.err({ earlier: before.handle, later: claim.handle })
		}
		before = claim
	}
	const handleAt = new Map(claims.map((claim) => [claim.code, claim.handle]))
	return Result.ok(
		Array.from({ length: minted }, (_, code): CodeSlot => {
			const handle = handleAt.get(code)
			return handle === undefined ? { kind: "hole" } : { kind: "live", handle }
		})
	)
}

/**
 * An open-typed field's code space within a relation: the distinct values of its column, ascending in the field type's
 * order, a value's code its position, beside each row's code. These codes never leave the relation's constant, so they
 * need not stay stable when its rows change.
 */
export interface Dictionary<V> {
	readonly values: ReadonlyArray<V>
	/** The code of each row's value, in row order. */
	readonly codes: ReadonlyArray<number>
}

/** The position of `value` among `values`, ascending in `order` and distinct, or undefined when none equals it. */
const searchSorted = <V>(
	values: ReadonlyArray<V>,
	value: V,
	order: Comparator<V>
): number | undefined => {
	let low = 0
	let high = values.length
	while (low < high) {
		const middle = Math.floor((low + high) / 2)
		const sign = order(defined(values[middle], "a position inside the search range"), value)
		if (sign === 0) {
			return middle
		}
		if (sign < 0) {
			low = middle + 1
		} else {
			high = middle
		}
	}
	return undefined
}

/** The code space of an open-typed column whose values `order` sorts, values it ties being one value. */
export const dictionaryOf = <V>(column: ReadonlyArray<V>, order: Comparator<V>): Dictionary<V> => {
	const values: Array<V> = []
	for (const value of column.toSorted(order)) {
		const last = values.at(-1)
		if (last === undefined || order(last, value) !== 0) {
			values.push(value)
		}
	}
	return {
		values,
		codes: column.map((value) =>
			defined(searchSorted(values, value, order), "a column's value is in its own dictionary")
		)
	}
}

/** One owner's run of a fin coordinate: the code of its first slot, and how many slots it holds. */
export interface FinRun {
	readonly start: bigint
	readonly count: bigint
}

/**
 * A `fin(O, n)` coordinate, the dependent sum Σ o. Fin(n o) of each owner's slots: the owners that hold a slot, each by
 * its index, with its run. Owners hold consecutive runs in index order, the first from code 0, and an owner of no slot
 * holds no run, so the codes are exactly 0 to `size` - 1, each one owner's slot.
 */
export interface FinSpace {
	readonly runs: ReadonlyMap<bigint, FinRun>
	readonly size: bigint
}

/** The fin coordinate whose owners hold the counts `counts`, each owner by its index, in any order. */
export const finSpace = (counts: ReadonlyMap<bigint, bigint>): FinSpace => {
	const runs = new Map<bigint, FinRun>()
	let size = 0n
	for (const [owner, count] of [...counts].toSorted(([a], [b]) => compareBigints(a, b))) {
		if (count > 0n) {
			runs.set(owner, { start: size, count })
			size += count
		}
	}
	return { runs, size }
}

/** The number of codes a fin coordinate holds: every owner's slots. */
export const finSize = (space: FinSpace): bigint => space.size

/**
 * The code of slot `at` of `owner` in a fin coordinate, its owner's prefix offset plus `at`, or undefined when the owner
 * holds no such slot: a slot at or past its owner's count would be the next owner's first, the alias the coordinate's
 * reader refuses.
 */
export const finDigit = (space: FinSpace, owner: bigint, at: bigint): bigint | undefined => {
	const run = space.runs.get(owner)
	return run !== undefined && at >= 0n && at < run.count ? run.start + at : undefined
}

/** Bigint order. */
const compareBigints: Comparator<bigint> = (a, b) => (a === b ? 0 : a < b ? -1 : 1)

/** The points of a space whose coordinates hold `sizes` codes each: their product, 1 for a space of no coordinate. */
export const spaceSize = (sizes: ReadonlyArray<number>): bigint =>
	sizes.reduce((points, size) => points * BigInt(size), 1n)

/**
 * The index of `digits` in the space whose coordinates hold `sizes` codes each, in mixed radix, row-major with the first
 * coordinate most significant: ((d₁·s₂ + d₂)·s₃ + d₃)…. It is undefined unless the digits name a point of the space,
 * one per coordinate and each a whole number below its coordinate's size, so no digit ever carries into its neighbour.
 */
export const rowMajorIndex = (
	sizes: ReadonlyArray<number>,
	digits: ReadonlyArray<number>
): bigint | undefined => {
	if (digits.length !== sizes.length) {
		return undefined
	}
	let index = 0n
	for (const [position, size] of sizes.entries()) {
		const digit = digits[position]
		if (digit === undefined || !Number.isInteger(digit) || digit < 0 || digit >= size) {
			return undefined
		}
		index = index * BigInt(size) + BigInt(digit)
	}
	return index
}

/**
 * The bits of a cell over a payload space of `points` codes: the fewest that hold 0 for absent and 1 + c for every
 * payload code c, ⌈log₂(1 + points)⌉. A set's payload space has one point, so its cells are one bit.
 */
export const cellWidth = (points: bigint): number => {
	let width = 0
	while (1n << BigInt(width) <= points) {
		width += 1
	}
	return width
}

/**
 * A coordinate of a dependent key's block, after its owner prefix: a closed id's codes, `size` of them, or the slots of
 * a fin coordinate, as many as count `count` of the key's owner states.
 */
export type BlockCoordinate =
	| { readonly kind: "codes"; readonly size: number }
	| { readonly kind: "slots"; readonly count: number }

/**
 * A closed relation's key space, which its key's codes index:
 *
 * - a product of closed ids, `sizes` codes each, indexed in mixed radix, row-major with the first coordinate most
 *   significant;
 * - a dependent sum over an owner prefix of closed ids: each owner, by the mixed-radix index of its codes, holds a
 *   block, the mixed radix of the block's coordinates at the radices the owner gives them (a closed id's size, or one
 *   of its counts for a slot), and the blocks lie end to end in owner order (`fin`, the fin coordinate of the block
 *   sizes). An owner `counts` holds no counts for holds no slot.
 */
export type KeySpace =
	| { readonly kind: "product"; readonly sizes: NonEmptyReadonlyArray<number> }
	| {
			readonly kind: "dependent"
			readonly owner: NonEmptyReadonlyArray<number>
			readonly block: NonEmptyReadonlyArray<BlockCoordinate>
			readonly counts: ReadonlyMap<bigint, NonEmptyReadonlyArray<number>>
			readonly fin: FinSpace
	  }

/** A dependent key space: an owner prefix, its block, each owner's counts, and the blocks' fin coordinate. */
export type DependentSpace = Extract<KeySpace, { readonly kind: "dependent" }>

/**
 * The radices of the block `block` at the owner of index `owner`: each slot coordinate's count there, 0 for an owner
 * `counts` holds none for, and each closed id's size.
 */
export const blockRadices = (
	block: NonEmptyReadonlyArray<BlockCoordinate>,
	counts: ReadonlyMap<bigint, NonEmptyReadonlyArray<number>>,
	owner: bigint
): NonEmptyReadonlyArray<number> => {
	const held = counts.get(owner)
	return mapNonEmpty(block, (c) => (c.kind === "codes" ? c.size : (held?.[c.count] ?? 0)))
}

/**
 * The dependent key space of the owner prefix `owner`, the block `block`, and each owner's counts by its index, the
 * counts its slot coordinates read. The block holds a slot, so an owner absent from `counts`, every count 0, holds an
 * empty block; a block of closed ids alone is a product, which is no dependent space.
 */
export const dependentSpace = (
	owner: NonEmptyReadonlyArray<number>,
	block: NonEmptyReadonlyArray<BlockCoordinate>,
	counts: ReadonlyMap<bigint, NonEmptyReadonlyArray<number>>
): DependentSpace => {
	if (!block.some((c) => c.kind === "slots")) {
		throw defect("a dependent space's block holds a slot")
	}
	return {
		kind: "dependent",
		owner,
		block,
		counts,
		fin: finSpace(
			new Map(
				Array.from(counts.keys(), (o) => [o, spaceSize(blockRadices(block, counts, o))] as const)
			)
		)
	}
}

/** The cells a key space holds: every point of a product, every owner's block of a dependent sum. */
export const keyCells = (space: KeySpace): bigint =>
	space.kind === "product" ? spaceSize(space.sizes) : finSize(space.fin)

/** The fields a key space reads, one digit each: a product's coordinates, or a dependent sum's owner, then its block. */
const keyArity = (space: KeySpace): number =>
	space.kind === "product" ? space.sizes.length : space.owner.length + space.block.length

/**
 * The cell of `digits`, one per coordinate of the key space in key order, or undefined unless they name a point of it:
 * each digit a whole number below its coordinate's size, and each slot digit below its owner's count. A slot digit at
 * or past its owner's count would carry into the owner's next slot or the next owner's block, the alias the range
 * check refuses.
 */
export const keyIndex = (space: KeySpace, digits: ReadonlyArray<number>): bigint | undefined => {
	if (space.kind === "product") {
		return rowMajorIndex(space.sizes, digits)
	}
	if (digits.length !== keyArity(space)) {
		return undefined
	}
	const owner = rowMajorIndex(space.owner, digits.slice(0, space.owner.length))
	if (owner === undefined) {
		return undefined
	}
	const local = rowMajorIndex(
		blockRadices(space.block, space.counts, owner),
		digits.slice(space.owner.length)
	)
	return local === undefined ? undefined : finDigit(space.fin, owner, local)
}

/** A closed relation's coordinates: its key's space, and the codes each payload coordinate holds, in their order. */
export interface CellLayout {
	readonly key: KeySpace
	readonly payload: ReadonlyArray<number>
}

/** A row split into its key's values and its payload's, each in its relation's order. */
export interface Split<V> {
	readonly key: ReadonlyArray<V>
	readonly payload: ReadonlyArray<V>
}

/** A row as the encoder reads it: its key's codes and its payload's codes, one per coordinate. */
export type Tuple = Split<number>

/** A cell the relation holds: its key's index, and its payload's code c. The cell holds 1 + c. */
export interface Entry {
	readonly index: bigint
	readonly payload: bigint
}

/**
 * A closed relation as its string of cells: `cells` cells of `width` bits, each 0 but the entries', which are ascending
 * by index and one per index. The string is exactly `cells · width` bits, so a read at an index past either end reads
 * outside it, which PostgreSQL's substring answers with the empty string, whose value is 0: absent.
 */
export interface Constant {
	readonly cells: bigint
	readonly width: number
	readonly entries: ReadonlyArray<Entry>
}

/** Two rows at one key with different payloads, by their positions in the input: the relation's key does not hold. */
export interface KeyCollision {
	readonly first: number
	readonly second: number
}

/** Index order. */
const compareIndexes: Comparator<Entry> = (a, b) =>
	a.index === b.index ? 0 : a.index < b.index ? -1 : 1

/**
 * The string of cells of a relation's tuples, whose codes lie in its layout's coordinates. A relation is a set of rows,
 * so a tuple stated twice is one cell; two tuples at one key with different payloads have no single cell, and are
 * refused as the key's collision.
 */
export const constantOf = (
	layout: CellLayout,
	tuples: ReadonlyArray<Tuple>
): Result.Result<Constant, KeyCollision> => {
	const held = new Map<bigint, { readonly row: number; readonly payload: bigint }>()
	for (const [row, tuple] of tuples.entries()) {
		const index = defined(
			keyIndex(layout.key, tuple.key),
			"a tuple's key codes name a point of its relation's key space"
		)
		const payload = defined(
			rowMajorIndex(layout.payload, tuple.payload),
			"a tuple's payload codes lie in its relation's payload coordinates"
		)
		const earlier = held.get(index)
		if (earlier === undefined) {
			held.set(index, { row, payload })
		} else if (earlier.payload !== payload) {
			return Result.err({ first: earlier.row, second: row })
		}
	}
	return Result.ok({
		cells: keyCells(layout.key),
		width: cellWidth(spaceSize(layout.payload)),
		entries: Array.from(held, ([index, { payload }]): Entry => ({ index, payload })).toSorted(
			compareIndexes
		)
	})
}

/**
 * The digest a constant's function is named by: SHA-256 over the constant's canonical content (its cells, its width and
 * its entries) under the fingerprint domain "closed-constant", so equal constants share one function and a changed one
 * is a new function.
 */
export const constantDigestOf = (constant: Constant): ConstantDigest<"closed-constant"> =>
	constantDigest(
		"closed-constant",
		{
			cells: constant.cells,
			width: constant.width,
			entries: constant.entries.map((entry) => [entry.index, entry.payload])
		},
		everyProperty
	)

/**
 * A constant's bits as a bit-string literal: its hex digits, four bits each, most significant first, then the zero to
 * three bits past its last whole digit in binary. Together they are exactly the constant's cells times its width bits.
 */
export interface BitLiteral {
	readonly hex: string
	readonly tail: string
}

/** Hexadecimal's sixteen digits, in their values' order. */
const hexDigits = "0123456789ABCDEF"

/** The bits a cell of value `value` sets, `width` of them most significant first, from bit `at` of `bytes`. */
const writeCell = (bytes: Uint8Array, at: bigint, width: number, value: bigint): void => {
	for (let bit = 0; bit < width; bit += 1) {
		if (((value >> BigInt(width - 1 - bit)) & 1n) === 0n) {
			continue
		}
		const position = Number(at) + bit
		const byte = Math.floor(position / 8)
		bytes[byte] = (bytes[byte] ?? 0) | (0x80 >> (position % 8))
	}
}

/** Bit `position` of `bytes`, most significant first: 0 or 1. */
const bitAt = (bytes: Uint8Array, position: number): number =>
	((bytes[Math.floor(position / 8)] ?? 0) >> (7 - (position % 8))) & 1

/**
 * A constant as its bit-string literal: each entry's cell holds 1 + its payload code, every other cell 0, the string
 * the pack of its rows builds. The constant's bits are at most what one string the host builds holds four to a digit;
 * the caller bounds them before (the printer refuses a longer statement).
 */
export const literalOf = (constant: Constant): BitLiteral => {
	const bits = Number(constant.cells * BigInt(constant.width))
	const bytes = new Uint8Array(Math.ceil(bits / 8))
	for (const entry of constant.entries) {
		writeCell(bytes, entry.index * BigInt(constant.width), constant.width, 1n + entry.payload)
	}
	const whole = Math.floor(bits / 4)
	const hex: Array<string> = []
	for (let digit = 0; digit < whole; digit += 1) {
		const byte = bytes[Math.floor(digit / 2)] ?? 0
		hex.push(
			defined(hexDigits[digit % 2 === 0 ? byte >> 4 : byte & 0x0f], "a nibble is a hex digit")
		)
	}
	const tail: Array<string> = []
	for (let position = whole * 4; position < bits; position += 1) {
		tail.push(bitAt(bytes, position) === 1 ? "1" : "0")
	}
	return { hex: hex.join(""), tail: tail.join("") }
}

/** A bit-string literal that is no constant of its stated layout: a digit no hex or binary digit, or a wrong length. */
export type LiteralFault =
	| { readonly kind: "digit"; readonly at: number }
	| { readonly kind: "length"; readonly bits: bigint; readonly expected: bigint }

/**
 * The constant a bit-string literal states, read as `cells` cells of `width` bits: each cell of value v > 0 an entry
 * of payload code v - 1. Refused when a character is no digit of its part, hex or binary, or when the literal's bits are
 * not exactly cells times width.
 */
export const constantOfLiteral = (
	literal: BitLiteral,
	cells: bigint,
	width: number
): Result.Result<Constant, LiteralFault> => {
	const expected = cells * BigInt(width)
	const bits = BigInt(literal.hex.length * 4 + literal.tail.length)
	if (bits !== expected) {
		return Result.err({ kind: "length", bits, expected })
	}
	const bytes = new Uint8Array(Math.ceil(Number(bits) / 8))
	for (const [at, char] of Array.from(literal.hex).entries()) {
		const value = hexDigits.indexOf(char.toUpperCase())
		if (value < 0) {
			return Result.err({ kind: "digit", at })
		}
		const byte = Math.floor(at / 2)
		bytes[byte] = (bytes[byte] ?? 0) | (at % 2 === 0 ? value << 4 : value)
	}
	for (const [i, char] of Array.from(literal.tail).entries()) {
		if (char !== "0" && char !== "1") {
			return Result.err({ kind: "digit", at: literal.hex.length + i })
		}
		if (char === "1") {
			const position = literal.hex.length * 4 + i
			const byte = Math.floor(position / 8)
			bytes[byte] = (bytes[byte] ?? 0) | (0x80 >> (position % 8))
		}
	}
	const entries: Array<Entry> = []
	for (let index = 0n; index < cells; index += 1n) {
		let value = 0n
		const start = Number(index) * width
		for (let bit = 0; bit < width; bit += 1) {
			value = (value << 1n) | BigInt(bitAt(bytes, start + bit))
		}
		if (value > 0n) {
			entries.push({ index, payload: value - 1n })
		}
	}
	return Result.ok({ cells, width, entries })
}

/** A relation's heading as a side reads it: its fields in declared order, and its declared keys. */
export interface Heading {
	readonly fields: NonEmptyReadonlyArray<string>
	readonly keys: ReadonlyArray<NonEmptyReadonlyArray<string>>
}

/**
 * A side as a closed relation of its own: its key's fields, its payload's fields, and its rows split between them, one
 * per key, by the canonical text of the key's values (sideOf). A side is a set: a row its projection repeats is one row.
 */
export interface CellSide<V> {
	readonly key: NonEmptyReadonlyArray<string>
	readonly payload: ReadonlyArray<string>
	readonly rows: ReadonlyMap<string, Split<V>>
}

/**
 * The side of `rows`, a closed relation's rows in its heading's field order, on the fields `terms`, as a closed relation
 * of its own. Its key is the smallest declared key whose fields the side contains, the first declared among the
 * smallest, in that key's order; a side that contains no declared key is keyed by all its fields. Its payload is its
 * other fields, in term order. The rows of a selected side are the rows its predicate selects, each once by its key's
 * text (`text`, each value's canonical text), in key text order: two rows a projection onto a side keyed by all its
 * fields makes equal are one row, and a side keyed by a declared key holds one row per key, which the closed relation's
 * key law makes one payload.
 */
export const sideOf = <V>(
	heading: Heading,
	terms: NonEmptyReadonlyArray<string>,
	rows: ReadonlyArray<ReadonlyArray<V>>,
	text: (value: V) => string
): CellSide<V> => {
	const smallest = heading.keys.reduce<NonEmptyReadonlyArray<string> | undefined>(
		(best, declared) =>
			declared.every((field) => terms.includes(field)) &&
			(best === undefined || declared.length < best.length)
				? declared
				: best,
		undefined
	)
	const key = smallest ?? terms
	const payload = terms.filter((term) => !key.includes(term))
	const positions = new Map(heading.fields.map((field, position) => [field, position]))
	const at = (fields: ReadonlyArray<string>): ReadonlyArray<number> =>
		fields.map((field) => defined(positions.get(field), "a side's field is a field of its heading"))
	const keyAt = at(key)
	const payloadAt = at(payload)
	const cell = (row: ReadonlyArray<V>, position: number): V =>
		defined(row[position], "a row holds a value for every field of its heading")
	const split = rows.map((row): Split<V> => ({
		key: keyAt.map((position) => cell(row, position)),
		payload: payloadAt.map((position) => cell(row, position))
	}))
	const keyed = new Map(split.map((row) => [JSON.stringify(row.key.map(text)), row] as const))
	return {
		key,
		payload,
		rows: new Map([...keyed].toSorted(([a], [b]) => compareStrings(a, b)))
	}
}
