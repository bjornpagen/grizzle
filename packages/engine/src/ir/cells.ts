/**
 * The cells encoder: the one encoding of a closed relation as its entries over a space of cells, which every constant,
 * domain and lookup of a closed relation reads.
 *
 * A closed relation has no extent in the database. Its rows erase to one sorted array of codes:
 * - every field has a code space: a closed id's is its roster's codes, holes included, and an open-typed field's is its
 *   active domain in the relation, in sorted order;
 * - the key's codes index a space of cells in mixed radix, row-major in the key's declared order, one cell per point of
 *   the key's space; a key whose fields after an owner prefix hold slots of `fin(O, n)`, O a closed relation over that
 *   prefix, is a dependent sum instead, each owner's block of the mixed radix at its own counts after every earlier
 *   owner's (KeySpace), so a dependent coordinate stays dense;
 * - a row is the entry at its key's cell with its payload's mixed-radix code c, and its code is index · P + c, P the
 *   payload space's codes (1 for a set, which has no payload), so the codes ascend with the cells they index and each
 *   names one cell and one payload.
 *
 * A constant is its entries, O(rows) whatever the size of its key space, and a read finds a key's entry by binary search
 * over the codes (sql/constants.ts). Sizes, indexes and payload codes are bigints, exact over any space. A bound on them
 * is the caller's.
 */
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { type ReadonlyTupleMap, TupleMap } from "@bjornpagen/grizzle-text/base/tuple-map"
import { isAsciiDigits } from "@bjornpagen/grizzle-text/text"
import { everyProperty } from "#compiler/core/canonical.ts"
import { type ConstantDigest, constantDigest } from "#compiler/core/fingerprint.ts"
import { type Comparator, compareStrings } from "#compiler/core/order.ts"
import { compareQuotedTuples } from "#compiler/core/text.ts"
import type { RosterHandles, RosterOrder } from "#compiler/ir/scalar.ts"

/** One code of a roster: the live handle it names, or the hole a removed handle left, which no handle takes again. */
export type CodeSlot =
	| { readonly kind: "live"; readonly handle: string }
	| { readonly kind: "hole" }

/**
 * A roster's codes, code c at position c. Codes are append-only, so the length counts every code the roster has ever
 * minted, and it is the roster's code space: a closed id indexes by it and a set over the roster has one bit per code,
 * holes included, padded to whole hex digits (ir/codes.ts RosterCodec). A roster not yet installed has no codes.
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
 * its order and handles in that order (ir/scalar.ts RosterHandles).
 *
 * Its codes are history: each declared handle stands for a previous handle, the one a rename names it from, or else
 * itself unless a rename moves it away. It keeps that handle's live code, so a code never changes meaning; a handle
 * with none takes the next code past every code minted before, in the order the handles are given. Every code no
 * declared handle keeps is a hole, and a hole stays one.
 *
 * An ordered roster's comparison order is its codes' order, so a handle declared after another must hold a later code:
 * new handles append, and a declaration that puts two handles out of their codes' order is refused with the first such
 * pair (firstInversion). An unordered roster has no order, so any order of its handles holds its codes.
 */
export const rosterCodes = (
	previous: RosterCodes,
	renames: ReadonlyMap<string, string>,
	roster: RosterHandles
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
	for (const handle of roster.handles) {
		const kept = keptCode(handle)
		if (kept === undefined) {
			claims.push({ handle, code: minted })
			minted += 1
		} else {
			claims.push({ handle, code: kept })
		}
	}
	const reordered = reorderOf[roster.order](claims)
	if (reordered !== undefined) {
		return Result.err(reordered)
	}
	const handleAt = new Map(claims.map((claim) => [claim.code, claim.handle]))
	return Result.ok(
		Array.from({ length: minted }, (_, code): CodeSlot => {
			const handle = handleAt.get(code)
			return handle === undefined ? { kind: "hole" } : { kind: "live", handle }
		})
	)
}

/** The first two declared handles out of their codes' order, `earlier` declared first and `later` the lower code. */
const firstInversion = (claims: ReadonlyArray<Claim>): Reordered | undefined => {
	let before: Claim | undefined
	for (const claim of claims) {
		if (before !== undefined && claim.code < before.code) {
			return { earlier: before.handle, later: claim.handle }
		}
		before = claim
	}
	return undefined
}

/**
 * The reorder a declaration of each order is refused for: an ordered roster's first inversion, and none of an unordered
 * or a zone roster's, whose codes follow no order.
 */
const reorderOf: {
	readonly [O in RosterOrder]: (claims: ReadonlyArray<Claim>) => Reordered | undefined
} = {
	ordered: firstInversion,
	unordered: () => undefined,
	zones: () => undefined
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
	return mapNonEmpty(block, (c) =>
		c.kind === "codes"
			? c.size
			: held === undefined
				? 0
				: defined(held[c.count], "an owner's count for each slot coordinate of its block")
	)
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
		defect("a dependent space's block holds a slot")
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

/** A cell the relation holds: its key's index, and its payload's code c. */
export interface Entry {
	readonly index: bigint
	readonly payload: bigint
}

/**
 * A closed relation as its entries: a key space of `cells` cells, a payload space of `points` codes, and the cells it
 * holds, ascending by index and one per index, each with a payload code below `points`. `points` is at least 1: a set's
 * payload space, of no coordinate, has one point, and a payload space of no point holds no row, so 1 states it as well.
 * It is installed as two parallel arrays (sql/constants.ts ConstantFunctions): its cells, every entry's index ascending
 * after the sentinel -1 (cellsLiteralOf), and, where its payload space holds more than one code, its payloads, every
 * entry's payload code in the same order (payloadsLiteralOf); a payload space of one code holds no information past its
 * cells.
 */
export interface Constant {
	readonly cells: bigint
	readonly points: bigint
	readonly entries: ReadonlyArray<Entry>
}

/**
 * The payload codes a constant over `payload` states, `points` (Constant): the payload space's, or 1 for a space of no
 * point, which holds no row.
 */
const payloadPoints = (payload: ReadonlyArray<number>): bigint => {
	const points = spaceSize(payload)
	return points === 0n ? 1n : points
}

/** Two rows at one key with different payloads, by their positions in the input: the relation's key does not hold. */
export interface KeyCollision {
	readonly first: number
	readonly second: number
}

/**
 * The constant of a relation's tuples, whose codes lie in its layout's coordinates. A relation is a set of rows,
 * so a tuple stated twice is one cell; two tuples at one key with different payloads have no single cell, and are
 * refused as the key's collision. Its entries are ordered by a native sort of their indexes, each below 2^64 as every
 * key space a constant is planned over is (physical/ddl/constants.ts constantMaxCells), the caller's bound.
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
		points: payloadPoints(layout.payload),
		entries: Array.from(BigUint64Array.from(held.keys()).toSorted(), (index): Entry => ({
			index,
			payload: defined(held.get(index), "a sorted index is a held one").payload
		}))
	})
}

/**
 * The digest a constant's cells are named by: SHA-256 over their canonical content (the key space's cells and the
 * entries' indexes) under the fingerprint domain "closed-constant", so equal cells share one function, a relation's and
 * a side's alike, and changed ones are a new function.
 */
export const cellsDigestOf = (
	cells: bigint,
	indexes: ReadonlyArray<bigint>
): ConstantDigest<"closed-constant"> =>
	constantDigest("closed-constant", { cells, indexes }, everyProperty)

/**
 * The digest a constant's payloads are named by: SHA-256 over their canonical content (the payload space's codes and the
 * entries' payload codes in index order) under the fingerprint domain "closed-constant", which no cells' content states.
 */
export const payloadsDigestOf = (
	points: bigint,
	payloads: ReadonlyArray<bigint>
): ConstantDigest<"closed-constant"> =>
	constantDigest("closed-constant", { points, payloads }, everyProperty)

/** A constant's entries' indexes, ascending: its cells. */
export const indexesOf = (constant: Constant): ReadonlyArray<bigint> =>
	constant.entries.map((entry) => entry.index)

/** A constant's entries' payload codes, in index order: its payloads. */
export const payloadsOf = (constant: Constant): ReadonlyArray<bigint> =>
	constant.entries.map((entry) => entry.payload)

/** Whether a constant's payloads are installed: where its payload space holds more than one code (Constant). */
export const holdsPayloads = (constant: Constant): boolean => constant.points > 1n

/** The sentinel a cells literal states first, below every index, so a binary search for any index lands on an element. */
const sentinel = -1n

/**
 * An array's literal, the text of the bigint[] PostgreSQL holds it as: its elements in decimal, of no sign but the
 * sentinel's and no leading 0, comma-separated in braces. Refused with the length it needs when it is longer than `limit`
 * characters, measured before it is joined.
 */
const literalWithin = (
	elements: ReadonlyArray<bigint>,
	limit: number
): Result.Result<string, number> => {
	const texts = elements.map((element) => element.toString())
	const length =
		texts.reduce((sum, text) => sum + text.length, 0) + Math.max(texts.length - 1, 0) + 2
	return length > limit ? Result.err(length) : Result.ok(`{${texts.join(",")}}`)
}

/** A constant's cells as their literal, `{-1,i1,i2,…}`: the sentinel, then every entry's index, ascending (literalWithin). */
export const cellsLiteralOf = (constant: Constant, limit: number): Result.Result<string, number> =>
	literalWithin([sentinel, ...indexesOf(constant)], limit)

/** A constant's payloads as their literal, `{c1,c2,…}`: every entry's payload code, in index order (literalWithin). */
export const payloadsLiteralOf = (
	constant: Constant,
	limit: number
): Result.Result<string, number> => literalWithin(payloadsOf(constant), limit)

/**
 * A literal that is no array of its stated layout: no braces around elements each after a comma, or a cells literal not
 * led by the sentinel -1 (`array`); an element, entry `at` counted from 1 past any sentinel, that is no decimal numeral of
 * no sign and no leading 0 (`element`); an index no greater than the one before it (`order`); an index at or past the
 * stated cells (`cell`); or a payload code at or past the stated payload codes (`code`).
 */
export type LiteralFault =
	| { readonly kind: "array" }
	| { readonly kind: "element"; readonly at: number }
	| { readonly kind: "order"; readonly at: number }
	| { readonly kind: "cell"; readonly at: number; readonly cell: bigint }
	| { readonly kind: "code"; readonly at: number; readonly code: bigint }

/** Whether an element's text is a decimal numeral of no sign and no leading 0, the one spelling a literal writes. */
const canonicalNumeral = (text: string): boolean =>
	text !== "" && isAsciiDigits(text, 0, text.length) && (text === "0" || !text.startsWith("0"))

/** A literal's elements, its text between its braces split at commas, none for `{}`; undefined for a text unbraced. */
const elementsOf = (text: string): ReadonlyArray<string> | undefined =>
	text.length < 2 || !text.startsWith("{") || !text.endsWith("}")
		? undefined
		: text === "{}"
			? []
			: text.slice(1, -1).split(",")

/**
 * The numerals of a literal's elements, each read by `admit` with its entry, counted from 1, and the value before it:
 * refused at the first element no canonical numeral, or the first `admit` refuses.
 */
const numeralsOf = (
	elements: ReadonlyArray<string>,
	admit: (value: bigint, at: number, before: bigint) => LiteralFault | undefined
): Result.Result<ReadonlyArray<bigint>, LiteralFault> => {
	const values: Array<bigint> = []
	let before = sentinel
	for (const [position, element] of elements.entries()) {
		const at = position + 1
		if (!canonicalNumeral(element)) {
			return Result.err({ kind: "element", at })
		}
		const value = BigInt(element)
		const fault = admit(value, at, before)
		if (fault !== undefined) {
			return Result.err(fault)
		}
		values.push(value)
		before = value
	}
	return Result.ok(values)
}

/**
 * The indexes a cells literal states over `cells` cells: its elements after the sentinel, strictly ascending, each below
 * `cells`. Refused otherwise (LiteralFault), so every literal is the one spelling of its cells.
 */
export const cellsOfLiteral = (
	text: string,
	cells: bigint
): Result.Result<ReadonlyArray<bigint>, LiteralFault> => {
	const elements = elementsOf(text)
	if (elements === undefined || elements[0] !== sentinel.toString()) {
		return Result.err({ kind: "array" })
	}
	return numeralsOf(elements.slice(1), (index, at, before) =>
		index <= before
			? { kind: "order", at }
			: index >= cells
				? { kind: "cell", at, cell: index }
				: undefined
	)
}

/**
 * The payload codes a payloads literal states over `points` payload codes: its elements, each below `points`. Refused
 * otherwise (LiteralFault), so every literal is the one spelling of its payloads.
 */
export const payloadsOfLiteral = (
	text: string,
	points: bigint
): Result.Result<ReadonlyArray<bigint>, LiteralFault> => {
	const elements = elementsOf(text)
	return elements === undefined
		? Result.err({ kind: "array" })
		: numeralsOf(elements, (code, at) => (code >= points ? { kind: "code", at, code } : undefined))
}

/** A relation's heading as a side reads it: its fields in declared order, and its declared keys. */
export interface Heading {
	readonly fields: NonEmptyReadonlyArray<string>
	readonly keys: ReadonlyArray<NonEmptyReadonlyArray<string>>
}

/**
 * A side as a closed relation of its own: its key's fields, its payload's fields, and its rows split between them, one
 * per key, by the canonical texts of the key's values (sideOf). A side is a set: a row its projection repeats is one row.
 */
export interface CellSide<V> {
	readonly key: NonEmptyReadonlyArray<string>
	readonly payload: ReadonlyArray<string>
	readonly rows: ReadonlyTupleMap<ReadonlyArray<string>, Split<V>>
}

/**
 * The side of `rows`, a closed relation's rows in its heading's field order, on the fields `terms`, as a closed relation
 * of its own. Its key is the smallest declared key whose fields the side contains, the first declared among the
 * smallest, in that key's order; a side that contains no declared key is keyed by all its fields. Its payload is its
 * other fields, in term order. The rows of a selected side are the rows its predicate selects, each once by its key's
 * texts (`text`, each value's canonical text), in the UTF-16 order of those texts as a JSON array spells them
 * (core/text.ts compareQuotedTuples): two rows a projection onto a side keyed by all its fields makes equal are one row,
 * and a side keyed by a declared key holds one row per key, which the closed relation's key law makes one payload.
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
	const keyed = new TupleMap<ReadonlyArray<string>, Split<V>>()
	for (const row of split) {
		keyed.set(row.key.map(text), row)
	}
	const order = compareQuotedTuples(compareStrings)
	const rowsInOrder = new TupleMap<ReadonlyArray<string>, Split<V>>()
	for (const [k, row] of [...keyed].toSorted(([a], [b]) => order(a, b))) {
		rowsInOrder.set(k, row)
	}
	return { key, payload, rows: rowsInOrder }
}
