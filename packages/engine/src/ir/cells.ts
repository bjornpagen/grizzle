/**
 * The cells encoder: the one encoding of a closed relation as a string of cells, which every constant, domain and
 * lookup of a closed relation reads.
 *
 * A closed relation has no extent in the database. Its rows erase to one bit string, read `width` bits at a time:
 * - every field has a code space: a closed id's is its roster's codes, holes included, and an open-typed field's is its
 *   active domain in the relation, in sorted order;
 * - the key's codes index the string in mixed radix, row-major in the key's declared order, so the string holds one
 *   cell per point of the key's space, and a `fin(O, n)` coordinate over a closed O numbers its slots owner by owner
 *   from a prefix offset, so a dependent coordinate stays dense;
 * - a cell is 0 where the relation holds no row and 1 + c where it does, c the payload's mixed-radix code, and its width
 *   is ⌈log₂(1 + |payload space|)⌉, so a relation with no payload, a set, has cells of one bit;
 * - a law that reads several codes packs them into one integer, 16 bits a code, so a roster's growth changes the
 *   constant and never a stored cell.
 *
 * Sizes, indexes and payload codes are bigints, exact over any space. A bound on them is the caller's.
 */
import { everyProperty } from "#compiler/core/canonical.ts"
import type { CompileBound, CompileError } from "#compiler/core/errors.ts"
import { digest } from "#compiler/core/fingerprint.ts"
import { defect, defined, invariant } from "#compiler/core/invariant.ts"
import { cellDigitBits } from "#compiler/core/limits.ts"
import { lastNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Comparator } from "#compiler/core/order.ts"
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

/**
 * A `fin(O, n)` coordinate over a closed O, the dependent sum of each owner's slots: owner o's slots take the codes from
 * `bounds[o]` up to `bounds[o + 1]`, so owners hold consecutive runs in code order, an owner whose count is 0 holds
 * none, and the last bound is the coordinate's size.
 */
export interface FinSpace {
	readonly bounds: NonEmptyReadonlyArray<number>
}

/** The fin coordinate whose owner o, by its code, holds `counts[o]` slots. */
export const finSpace = (counts: ReadonlyArray<number>): FinSpace => {
	const ends: Array<number> = []
	let total = 0
	for (const count of counts) {
		total += count
		ends.push(total)
	}
	return { bounds: [0, ...ends] }
}

/** The number of codes a fin coordinate holds: every owner's slots. */
export const finSize = (space: FinSpace): number => lastNonEmpty(space.bounds)

/**
 * The code of slot `at` of `owner` in a fin coordinate, its owner's prefix offset plus `at`, or undefined when the owner
 * has no such slot.
 */
export const finDigit = (space: FinSpace, owner: number, at: number): number | undefined => {
	const start = space.bounds[owner]
	const end = space.bounds[owner + 1]
	return start !== undefined &&
		end !== undefined &&
		Number.isInteger(at) &&
		at >= 0 &&
		start + at < end
		? start + at
		: undefined
}

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

/** A closed relation's coordinates: the codes each key coordinate and each payload coordinate holds, in their order. */
export interface Layout {
	readonly key: NonEmptyReadonlyArray<number>
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
	layout: Layout,
	tuples: ReadonlyArray<Tuple>
): Result.Result<Constant, KeyCollision> => {
	const held = new Map<bigint, { readonly row: number; readonly payload: bigint }>()
	for (const [row, tuple] of tuples.entries()) {
		const index = defined(
			rowMajorIndex(layout.key, tuple.key),
			"a tuple's key codes lie in its relation's key coordinates"
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
		cells: spaceSize(layout.key),
		width: cellWidth(spaceSize(layout.payload)),
		entries: Array.from(held, ([index, { payload }]): Entry => ({ index, payload })).toSorted(
			compareIndexes
		)
	})
}

/** A roster as the set of its live codes, over every code it has minted: a hole is a 0. */
export const rosterConstant = (codes: RosterCodes): Constant => {
	const live = codes.flatMap((slot, code): ReadonlyArray<Tuple> =>
		slot.kind === "live" ? [{ key: [code], payload: [] }] : []
	)
	const constant = constantOf({ key: [codes.length], payload: [] }, live)
	if (!constant.ok) {
		throw defect("a roster's live codes are distinct points of its code space")
	}
	return constant.value
}

/**
 * The constant as PostgreSQL's bit-string text: each cell's bits, most significant first, from cell 0. ResourceBound
 * (stringLength) when the text would be longer than `limit` characters, measured before it is built.
 */
export const bitText = (constant: Constant, limit: number): Result.Result<string, CompileBound> => {
	const bits = constant.cells * BigInt(constant.width)
	if (bits > BigInt(limit)) {
		return Result.err({ kind: "stringLength", limit, needed: Number(bits) })
	}
	const width = constant.width
	const parts: Array<string> = []
	let written = 0
	for (const entry of constant.entries) {
		const start = Number(entry.index) * width
		parts.push("0".repeat(start - written), (1n + entry.payload).toString(2).padStart(width, "0"))
		written = start + width
	}
	parts.push("0".repeat(Number(bits) - written))
	return Result.ok(parts.join(""))
}

/**
 * The digest a constant's function is named by: SHA-256 over the constant's canonical content (its cells, its width and
 * its entries) under the fingerprint domain "closed-constant", so equal constants share one function and a changed one
 * is a new function.
 */
export const constantDigest = (constant: Constant): Result.Result<string, CompileError> =>
	digest(
		"closed-constant",
		{
			cells: constant.cells,
			width: constant.width,
			entries: constant.entries.map((entry) => [entry.index, entry.payload])
		},
		everyProperty
	)

/** A relation's heading as a side reads it: its fields in declared order, and its declared keys. */
export interface Heading {
	readonly fields: NonEmptyReadonlyArray<string>
	readonly keys: ReadonlyArray<NonEmptyReadonlyArray<string>>
}

/** A side as a closed relation of its own: its key's fields, its payload's fields, and its rows split between them. */
export interface Side<V> {
	readonly key: NonEmptyReadonlyArray<string>
	readonly payload: ReadonlyArray<string>
	readonly rows: ReadonlyArray<Split<V>>
}

/**
 * The side of `rows`, a closed relation's rows in its heading's field order, on the fields `terms`, as a closed relation
 * of its own. Its key is the smallest declared key whose fields the side contains, the first declared among the
 * smallest, in that key's order; a side that contains no declared key is keyed by all its fields, a set. Its payload is
 * its other fields, in term order. The rows of a selected side are the rows its predicate selects.
 */
export const sideOf = <V>(
	heading: Heading,
	terms: NonEmptyReadonlyArray<string>,
	rows: ReadonlyArray<ReadonlyArray<V>>
): Side<V> => {
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
	return {
		key,
		payload,
		rows: rows.map((row) => ({
			key: keyAt.map((position) => cell(row, position)),
			payload: payloadAt.map((position) => cell(row, position))
		}))
	}
}

/**
 * The mask that reads one code out of a law's cell once it is shifted down: a digit's bits (cellDigitBits), all set. A
 * roster's codes are int2 values from 0, so every code fits one digit, and a roster that grows never moves another.
 */
export const codeMask = 2 ** cellDigitBits.value - 1

/**
 * The shift of the code at `position` among `count` codes in a law's cell: the last code sits in the lowest digit and
 * each earlier one a digit above the next, so the cell of (c₁, c₂, c₃) is (c₁ << 32) | (c₂ << 16) | c₃.
 */
export const codeShift = (count: number, position: number): number =>
	cellDigitBits.value * (count - 1 - position)

/**
 * The cell of a law that reads `codes`: each code in its own 16-bit digit at its shift, ORed together. Four codes of
 * int2 values from 0 fill an int8 and leave it non-negative.
 */
export const packCodes = (codes: ReadonlyArray<number>): bigint =>
	codes.reduce((cell, code, position) => {
		invariant(
			Number.isInteger(code) && code >= 0 && code <= codeMask,
			"a code fits one 16-bit digit of a law's cell"
		)
		return cell | (BigInt(code) << BigInt(codeShift(codes.length, position)))
	}, 0n)
