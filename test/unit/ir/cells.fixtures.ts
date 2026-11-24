/** What the properties of cells.test.ts read: its spaces, models and helpers. */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type * as EngineResult from "@bjornpagen/grizzle-text/base/result"
import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	shuffled,
	subarray,
	weighted
} from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order } from "effect"
import { maxStringLength } from "#compiler/core/canonical.ts"
import {
	type BlockCoordinate,
	type CellLayout,
	type CodeSlot,
	type Constant,
	cellsDigestOf,
	cellsLiteralOf,
	cellsOfLiteral,
	dependentSpace,
	constantOf as encodedOf,
	finDigit,
	finSize,
	finSpace,
	holdsPayloads,
	keyCells,
	type KeyCollision,
	keyIndex,
	payloadsDigestOf,
	payloadsLiteralOf,
	payloadsOfLiteral,
	rosterCodes,
	type RosterCodes,
	rowMajorIndex,
	sideOf,
	spaceSize,
	type Tuple
} from "#compiler/ir/cells.ts"
import { type RosterOrder, rosterOrders } from "#compiler/ir/scalar.ts"
import { failed, succeeded } from "#test/support/assert.ts"
import {
	oracleLiteral,
	oracleCells,
	oraclePayloads,
	payloadAt
} from "#test/support/closed/codes.ts"

/** A product layout, which most of these rules are stated over: each key coordinate's and payload coordinate's codes. */
interface Product {
	readonly key: NonEmptyReadonlyArray<number>
	readonly payload: ReadonlyArray<number>
}

/** The host encoder's constant of a product layout's tuples (ir/cells.ts constantOf over the product key space). */
const constantOf = (
	layout: Product,
	tuples: ReadonlyArray<Tuple>
): EngineResult.Result<Constant, KeyCollision> =>
	encodedOf(
		{ key: { kind: "product", sizes: layout.key }, payload: layout.payload } satisfies CellLayout,
		tuples
	)

/** Every point of the space whose coordinates hold `sizes` codes each, first coordinate most significant: an odometer. */
const odometer = (sizes: ReadonlyArray<number>): ReadonlyArray<ReadonlyArray<number>> => {
	const origin: ReadonlyArray<ReadonlyArray<number>> = [[]]
	return Arr.reduce(sizes, origin, (prefixes, size) =>
		Arr.flatMap(prefixes, (prefix) =>
			Array.from({ length: size }, (_, digit) => [...prefix, digit])
		)
	)
}

/** A point's digits as one key, for a Map of points and for a report. */
const pointKey = (digits: ReadonlyArray<number>): string =>
	Arr.join(
		Arr.map(digits, (digit) => `${digit}`),
		","
	)

/** `digits` with the digit at `at` replaced by `digit`. */
const replaced = (
	digits: ReadonlyArray<number>,
	at: number,
	digit: number
): ReadonlyArray<number> => Arr.map(digits, (d, j) => (j === at ? digit : d))

/**
 * The naive decoder: every cell of a constant read as PostgreSQL's reads find it, by scanning its cells for an element
 * equal to it (test/support/closed/codes.ts payloadAt), each held cell's index mapped back to its key by the odometer of
 * the key space and its payload code c to the payload at position c of the payload space's odometer. Its tuples come in
 * index order.
 */
const decoded = (layout: Product, constant: Constant): ReadonlyArray<Tuple> => {
	const payloads = odometer(layout.payload)
	const cells = oracleCells(constant)
	const codes = oraclePayloads(constant)
	return Arr.flatMap(odometer(layout.key), (key, index): ReadonlyArray<Tuple> => {
		const payload = payloadAt(cells, codes, BigInt(index))
		return payload === undefined
			? []
			: [
					{
						key,
						payload: defined(payloads[Number(payload)], `cell ${index} holds a payload code`)
					}
				]
	})
}

/** The payload codes a constant over a payload space of `points` points states: the points, or 1 for a space of none. */
const statedPoints = (points: number): bigint => (points === 0 ? 1n : BigInt(points))

/**
 * A key's code spaces: one to three coordinates whose sizes multiply to at most `cap`, a coordinate of no code among
 * them (an empty key space, after which each later coordinate holds at most one code).
 */
const keySizes =
	(cap: number): Gen<NonEmptyReadonlyArray<number>> =>
	(s) => {
		const arity = s.draw(int(1, 3))
		const sizes: Array<number> = []
		let points = 1
		for (let at = 0; at < arity; at += 1) {
			const size = s.draw(int(0, points === 0 ? 1 : Math.floor(cap / points)))
			sizes.push(size)
			points *= size
		}
		return nonEmpty(sizes)
	}

/** A closed relation of a box: its layout, and its tuples in the index order of its key space. */
interface Boxed {
	readonly layout: Product
	readonly rows: ReadonlyArray<Tuple>
}

/**
 * Every closed relation over a key space of `keySizes(cap)` and one of `payloads`: each point of the key space absent or
 * holding one of the payload space's codes.
 */
const relationIn =
	(
		cap: number,
		payloads: ReadonlyArray<ReadonlyArray<number>> & Readonly<{ 0: ReadonlyArray<number> }>
	): Gen<Boxed> =>
	(s) => {
		const key = s.draw(keySizes(cap))
		const payload = s.draw(element(payloads))
		const payloadPoints = odometer(payload)
		const rows = Arr.flatMap(odometer(key), (point): ReadonlyArray<Tuple> => {
			const cell = s.draw(int(0, payloadPoints.length))
			return cell === 0 ? [] : [{ key: point, payload: defined(payloadPoints[cell - 1]) }]
		})
		return { layout: { key, payload }, rows }
	}

/** What a key shape reached: one or three coordinates, an empty one, and each digit moved past its range. */
export type Shape =
	| "one coordinate"
	| "three coordinates"
	| "an empty coordinate"
	| "an aliasing digit"

/**
 * Every key shape of one to three coordinates of 0 to 5 codes each: 258 shapes, every point of each, and at every
 * point every coordinate's digit moved just outside its range (-1, its size, its size + 1, twice its size + 1, a
 * fraction).
 */
export const shapes: Gen<NonEmptyReadonlyArray<number>> = (s) => {
	const arity = s.draw(int(1, 3))
	return nonEmpty(Array.from({ length: arity }, () => s.draw(int(0, 5))))
}

/**
 * The index numbers the in-range points bijectively in the odometer's order, and names no point for a digit outside
 * its coordinate: oracle, the odometer, and for the alias Horner's rule run without the range proof, whose index
 * would land on another in-range point.
 */
export const bijection = (sizes: NonEmptyReadonlyArray<number>, c: Case<Shape>) =>
	Effect.sync(() => {
		const points = odometer(sizes)
		assert.equal(spaceSize(sizes), BigInt(points.length))
		for (const [position, point] of points.entries()) {
			assert.equal(rowMajorIndex(sizes, point), BigInt(position), `the point ${pointKey(point)}`)
			for (const [at, size] of sizes.entries()) {
				for (const outside of [-1, size, size + 1, 2 * size + 1, 0.5]) {
					const digits = replaced(point, at, outside)
					const unchecked = Arr.reduce(sizes, 0, (index, n, j) => index * n + defined(digits[j]))
					if (Number.isInteger(unchecked) && unchecked >= 0 && unchecked < points.length) {
						c.note("an aliasing digit")
					}
					assert.equal(rowMajorIndex(sizes, digits), undefined, `the digits ${pointKey(digits)}`)
				}
			}
		}
		const zeros = Arr.map(sizes, () => 0)
		assert.equal(rowMajorIndex(sizes, [...zeros, 0]), undefined, "one digit too many")
		assert.equal(rowMajorIndex(sizes, zeros.slice(1)), undefined, "one digit too few")
		if (sizes.length === 1) {
			c.note("one coordinate")
		}
		if (sizes.length === 3) {
			c.note("three coordinates")
		}
		if (sizes.includes(0)) {
			c.note("an empty coordinate")
		}
	})

/** What an owner roster reached: an owner with no slot, several owners with slots, or none. */
export type Owners = "an owner with no slot" | "several owners with slots" | "no owner"

/** Every closed owner roster of 0 to 4 owners, each holding 0 to 3 slots: 341 coordinates. */
export const owners: Gen<ReadonlyArray<number>> = (s) => {
	const count = s.draw(int(0, 4))
	return Array.from({ length: count }, () => s.draw(int(0, 3)))
}

/**
 * The prefix offsets are dense: slot `at` of owner o is the position of (o, at) in the list of every owner's slots,
 * owner by owner, so the codes are exactly 0 to the coordinate's size - 1, each once; no code names a slot an owner
 * lacks, at or past its count, the next owner's. Oracle: that list.
 */
export const dense = (counts: ReadonlyArray<number>, c: Case<Owners>) =>
	Effect.sync(() => {
		const slots = Arr.flatMap(counts, (count, owner) =>
			Array.from({ length: count }, (_, at) => [owner, at] as const)
		)
		const space = finSpace(
			new Map(Arr.map(counts, (count, owner) => [BigInt(owner), BigInt(count)] as const))
		)
		assert.equal(finSize(space), BigInt(slots.length))
		for (const [code, [owner, at]] of slots.entries()) {
			assert.equal(
				finDigit(space, BigInt(owner), BigInt(at)),
				BigInt(code),
				`slot ${at} of owner ${owner}`
			)
		}
		for (let owner = -1; owner <= counts.length; owner += 1) {
			const count = counts[owner] ?? 0
			for (const at of [-1, count, count + 1]) {
				assert.equal(
					finDigit(space, BigInt(owner), BigInt(at)),
					undefined,
					`slot ${at} of owner ${owner}`
				)
			}
		}
		if (counts.length === 0) {
			c.note("no owner")
		}
		if (counts.includes(0)) {
			c.note("an owner with no slot")
		}
		if (Arr.filter(counts, (count) => count > 0).length >= 2) {
			c.note("several owners with slots")
		}
	})

/** What a dependent space reached: an owner with no slot, a block of two slots, and each coordinate's order. */
export type Dependent =
	| "an owner with no slot"
	| "a block of two slots"
	| "a closed id after a slot"
	| "a closed id before a slot"
	| "two counts"
	| "an empty space"
	| "an aliasing slot digit"

/** A dependent key space: its owners, the block of coordinates each owner's slots hold, and each owner's counts. */
interface Space {
	readonly owners: number
	readonly block: NonEmptyReadonlyArray<BlockCoordinate>
	readonly counts: ReadonlyMap<bigint, NonEmptyReadonlyArray<number>>
}

/** A block coordinate: a closed id of 2 codes, or a slot of count 0 or of count 1. */
const coordinates: NonEmptyReadonlyArray<BlockCoordinate> = [
	{ kind: "codes", size: 2 },
	{ kind: "slots", count: 0 },
	{ kind: "slots", count: 1 }
]

/** A slot coordinate, of count 0 or of count 1. */
const slotted: NonEmptyReadonlyArray<BlockCoordinate> = [
	{ kind: "slots", count: 0 },
	{ kind: "slots", count: 1 }
]

/**
 * Every dependent space of an owner prefix of one closed id of 1 to 3 codes and a block of one or two coordinates,
 * each a closed id of 2 codes or a slot of count 0 or 1, at least one a slot (a block of closed ids alone is a
 * product), every owner holding each count its slots read 0 to 2, an owner whose counts are all 0 absent from the
 * counts as its count relation holding no row for it: 1,950 spaces.
 */
export const spaces: Gen<Space> = (s) => {
	const owners = s.draw(int(1, 3))
	const arity = s.draw(int(1, 2))
	const first = s.draw(element(arity === 1 ? slotted : coordinates))
	const block: NonEmptyReadonlyArray<BlockCoordinate> =
		arity === 1 ? [first] : [first, s.draw(element(first.kind === "codes" ? slotted : coordinates))]
	const read = new Set(Arr.flatMap(block, (c) => (c.kind === "slots" ? [c.count] : [])))
	const counts = new Map<bigint, NonEmptyReadonlyArray<number>>()
	for (let owner = 0; owner < owners; owner += 1) {
		const held: [number, number] = [0, 0]
		for (const count of [0, 1] as const) {
			if (read.has(count)) {
				held[count] = s.draw(int(0, 2))
			}
		}
		if (held[0] > 0 || held[1] > 0) {
			counts.set(BigInt(owner), held)
		}
	}
	return { owners, block, counts }
}

/** The radices owner `owner`'s block takes: a closed id's size, a slot's count there, 0 where it holds none. */
const radicesAt = (space: Space, owner: number): NonEmptyReadonlyArray<number> =>
	Arr.map(space.block, (c) =>
		c.kind === "codes" ? c.size : (space.counts.get(BigInt(owner))?.[c.count] ?? 0)
	)

/**
 * The dependent sum's points in order, every owner's block after every earlier owner's, each block in its own
 * odometer's order at its owner's radices: the list the index must number. Oracle: Σ o. Π radices(o), written out.
 */
const pointsOf = (space: Space): ReadonlyArray<ReadonlyArray<number>> =>
	Arr.flatMap(
		Array.from({ length: space.owners }, (_, owner) => owner),
		(owner) => Arr.map(odometer(radicesAt(space, owner)), (local) => [owner, ...local])
	)

/**
 * The index numbers the dependent sum's points bijectively in owner order, and names no point for any other digits:
 * a slot code at or past its owner's count, an owner past the prefix, too few or too many digits. Every slot digit of
 * the box (0 to 3, past every count) is tried, and where Horner's rule at the owner's radices, run without the range
 * check, would land on another point's cell, the case notes the alias the check refuses. Oracles: the point list,
 * and a string of cells encoded over the space decodes back to its tuples.
 */
export const theorem = (space: Space, c: Case<Dependent>) =>
	Effect.sync(() => {
		const keySpace = dependentSpace([space.owners], space.block, space.counts)
		const points = pointsOf(space)
		assert.equal(keyCells(keySpace), BigInt(points.length), "the space holds every owner's block")
		const positions = new Map(Arr.map(points, (p, at) => [pointKey(p), at] as const))
		const bases = Array.from(
			{ length: space.owners },
			(_, owner) => Arr.filter(points, (p) => (p[0] ?? 0) < owner).length
		)
		const box = odometer([
			space.owners,
			...Arr.map(space.block, (b) => (b.kind === "codes" ? b.size : 4))
		])
		for (const digits of box) {
			const at = positions.get(pointKey(digits))
			if (at !== undefined) {
				assert.equal(keyIndex(keySpace, digits), BigInt(at), `the point ${pointKey(digits)}`)
				continue
			}
			assert.equal(keyIndex(keySpace, digits), undefined, `the digits ${pointKey(digits)}`)
			const owner = defined(digits[0])
			const unchecked = Arr.reduce(
				Arr.zip(digits.slice(1), radicesAt(space, owner)),
				0,
				(local, [digit, radix]) => local * radix + digit
			)
			const landing = defined(bases[owner]) + unchecked
			if (landing < points.length) {
				c.note("an aliasing slot digit")
			}
		}
		const arity = 1 + space.block.length
		const zeros = Array.from({ length: arity }, () => 0)
		assert.equal(
			keyIndex(keySpace, [space.owners, ...zeros.slice(1)]),
			undefined,
			"an owner past the prefix"
		)
		assert.equal(keyIndex(keySpace, [-1, ...zeros.slice(1)]), undefined, "a negative owner")
		assert.equal(keyIndex(keySpace, zeros.slice(1)), undefined, "one digit too few")
		assert.equal(keyIndex(keySpace, [...zeros, 0]), undefined, "one digit too many")
		const rows = Arr.map(points, (key, at): Tuple => ({ key, payload: [at] }))
		const encoded = succeeded(
			encodedOf({ key: keySpace, payload: [Math.max(1, points.length)] }, rows)
		)
		const cells = oracleCells(encoded)
		const codes = oraclePayloads(encoded)
		const read = Arr.flatMap(
			Array.from({ length: points.length }, (_, at) => at),
			(at): ReadonlyArray<Tuple> => {
				const payload = payloadAt(cells, codes, BigInt(at))
				return payload === undefined
					? []
					: [{ key: defined(points[at]), payload: [Number(payload)] }]
			}
		)
		assert.deepEqual(read, rows, "decode ∘ encode = id over the dependent space")
		const read0 = new Set(Arr.flatMap(space.block, (b) => (b.kind === "slots" ? [b.count] : [])))
		if (points.length === 0) {
			c.note("an empty space")
		}
		if (space.counts.size < space.owners && read0.size > 0) {
			c.note("an owner with no slot")
		}
		if (Arr.filter(space.block, (b) => b.kind === "slots").length === 2) {
			c.note("a block of two slots")
		}
		if (read0.size === 2) {
			c.note("two counts")
		}
		const [first, second] = space.block
		if (first.kind === "slots" && second?.kind === "codes") {
			c.note("a closed id after a slot")
		}
		if (first.kind === "codes" && second?.kind === "slots") {
			c.note("a closed id before a slot")
		}
	})

/** What a closed relation reached: a set or a function, an empty key space, and each payload's form. */
export type Relation =
	| "a set"
	| "a function"
	| "an empty key space"
	| "an empty payload space"
	| "every cell present"
	| "three key coordinates"

/**
 * The box: every closed relation over a key of one to three coordinates whose sizes multiply to at most 4 (a
 * coordinate of no code among them), and a payload of none (a set, P = 1), one coordinate of 0, 1, 2 or 3 codes
 * (P = 1, 1, 2, 3) or two of 2 (P = 4): 11,915 relations.
 */
export const box = relationIn(4, [[], [0], [1], [2], [3], [2, 2]])

/**
 * decode ∘ encode = id: the constant states its key space's cells and its payload space's points (1 for a space of
 * none); its cells' literal, and its payloads' where its payload space holds more than one code, are the oracle's
 * spelling of its arrays, exactly, and read back to its indexes and payload codes; the naive decoder reads back exactly
 * the relation's tuples from those arrays, and a read past the last cell is absent; and each literal, O(rows) whatever
 * the key space, is refused one character short of its length. Oracle: the naive tuple-set model and a scan of every
 * cell.
 */
export const roundTrip = ({ layout, rows }: Boxed, c: Case<Relation>) =>
	Effect.sync(() => {
		const encoded = succeeded(constantOf(layout, rows))
		const cells = odometer(layout.key).length
		const points = statedPoints(odometer(layout.payload).length)
		assert.equal(encoded.cells, BigInt(cells))
		assert.equal(encoded.points, points, "the payload space's points, 1 for a space of none")
		const cellsText = succeeded(cellsLiteralOf(encoded, maxStringLength))
		assert.equal(
			cellsText,
			oracleLiteral(oracleCells(encoded)),
			"the cells' literal is the oracle's"
		)
		const position = new Map(
			Arr.map(odometer(layout.key), (point, at) => [pointKey(point), BigInt(at)] as const)
		)
		assert.deepEqual(
			succeeded(cellsOfLiteral(cellsText, encoded.cells)),
			Arr.map(rows, (row) => defined(position.get(pointKey(row.key)), "a row's key is a point")),
			"the cells' literal reads back to the held indexes"
		)
		assert.ok(
			cellsText.length <= 5 + rows.length * (1 + BigInt(cells).toString().length),
			`the cells' literal of ${rows.length} rows, ${cellsText.length} characters, is O(rows)`
		)
		assert.equal(succeeded(cellsLiteralOf(encoded, cellsText.length)), cellsText)
		assert.deepEqual(failed(cellsLiteralOf(encoded, cellsText.length - 1)), cellsText.length)
		const payloads = oraclePayloads(encoded)
		assert.equal(
			payloads !== undefined,
			points > 1n,
			"payloads exactly where the payload space holds two codes"
		)
		assert.equal(holdsPayloads(encoded), points > 1n, "the engine installs payloads exactly there")
		if (payloads !== undefined) {
			const payloadsText = succeeded(payloadsLiteralOf(encoded, maxStringLength))
			assert.equal(payloadsText, oracleLiteral(payloads), "the payloads' literal is the oracle's")
			assert.deepEqual(
				succeeded(payloadsOfLiteral(payloadsText, encoded.points)),
				payloads,
				"the payloads' literal reads back to the payload codes"
			)
			assert.ok(
				payloadsText.length <= 2 + rows.length * (1 + points.toString().length),
				`the payloads' literal of ${rows.length} rows, ${payloadsText.length} characters, is O(rows)`
			)
			assert.deepEqual(
				failed(payloadsLiteralOf(encoded, payloadsText.length - 1)),
				payloadsText.length
			)
		}
		assert.deepEqual(decoded(layout, encoded), rows, "decode ∘ encode = id")
		for (const outside of [cells, cells + 1]) {
			assert.equal(
				payloadAt(oracleCells(encoded), payloads, BigInt(outside)),
				undefined,
				`the cell at ${outside}`
			)
		}
		if (layout.payload.length === 0) {
			c.note("a set")
		}
		if (points >= 2n) {
			c.note("a function")
		}
		if (cells === 0) {
			c.note("an empty key space")
		}
		if (odometer(layout.payload).length === 0) {
			c.note("an empty payload space")
		}
		if (cells > 0 && rows.length === cells) {
			c.note("every cell present")
		}
		if (layout.key.length === 3) {
			c.note("three key coordinates")
		}
	})

/** How a relation's rows were stated: out of index order, a row twice, or two payloads at one key. */
export type Stated =
	| "rows out of index order"
	| "a row stated twice"
	| "a key collision"
	| "a set"
	| "a function"

/** A relation's rows as a caller states them: in any order, some repeated, and in a named invalid variant a key collision. */
interface Statement {
	readonly layout: Product
	readonly relation: ReadonlyArray<Tuple>
	readonly stated: ReadonlyArray<Tuple>
}

/** `item` inserted into `items` at `at`. */
const insertedAt = <A>(items: ReadonlyArray<A>, at: number, item: A): ReadonlyArray<A> => [
	...items.slice(0, at),
	item,
	...items.slice(at)
]

/**
 * A relation past the exhaustive box (keys of up to three coordinates of 1 to 3 codes, payloads of up to two
 * coordinates of 3, w up to 4), stated in a drawn order with up to three repeated rows, and in one case in four a
 * second row at a present key with another payload: the named invalid case.
 */
export const statement: Gen<Statement> = (s) => {
	const key = nonEmpty(Array.from({ length: s.draw(int(1, 3)) }, () => s.draw(int(1, 3))))
	const payload = s.draw(element<ReadonlyArray<number>>([[], [2], [3], [3, 3]]))
	const payloads = odometer(payload)
	const relation = Arr.flatMap(odometer(key), (point): ReadonlyArray<Tuple> => {
		const present = s.draw(boolean)
		return present
			? [{ key: point, payload: defined(payloads[s.draw(int(0, payloads.length - 1))]) }]
			: []
	})
	let stated = s.draw(shuffled(relation, { min: relation.length, max: relation.length }))
	const repeats = relation.length === 0 ? 0 : s.draw(int(0, 3))
	for (let n = 0; n < repeats; n += 1) {
		const row = defined(stated[s.draw(int(0, stated.length - 1))])
		stated = insertedAt(stated, s.draw(int(0, stated.length)), row)
	}
	const collide =
		relation.length > 0 &&
		payloads.length >= 2 &&
		s.draw(
			weighted([
				[3, constant(false)],
				[1, constant(true)]
			])
		)
	if (collide) {
		const row = defined(relation[s.draw(int(0, relation.length - 1))])
		const others = Arr.filter(payloads, (p) => pointKey(p) !== pointKey(row.payload))
		const other = defined(others[s.draw(int(0, others.length - 1))])
		stated = insertedAt(stated, s.draw(int(0, stated.length)), { key: row.key, payload: other })
	}
	return { layout: { key, payload }, relation, stated }
}

/**
 * A relation is a set of rows: stated in any order and with repeats it encodes to the constant of its rows in index
 * order, and two payloads at one key are refused, naming the earliest row at that key and the first row that
 * disagrees with it. Oracle: the naive tuple-set model scanning the rows in order.
 */
export const setOfRows = ({ layout, relation, stated }: Statement, c: Case<Stated>) =>
	Effect.sync(() => {
		const seen = new Map<string, { readonly row: number; readonly payload: string }>()
		let collision: Option.Option<{ readonly first: number; readonly second: number }> =
			Option.none()
		for (const [row, tuple] of stated.entries()) {
			const at = pointKey(tuple.key)
			const payload = pointKey(tuple.payload)
			const earlier = seen.get(at)
			if (earlier === undefined) {
				seen.set(at, { row, payload })
			} else if (earlier.payload !== payload && Option.isNone(collision)) {
				collision = Option.some({ first: earlier.row, second: row })
			} else if (earlier.payload === payload) {
				c.note("a row stated twice")
			}
		}
		const encoded = constantOf(layout, stated)
		if (Option.isSome(collision)) {
			c.note("a key collision")
			assert.deepEqual(failed(encoded), collision.value)
			return
		}
		assert.deepEqual(succeeded(encoded), succeeded(constantOf(layout, relation)))
		assert.deepEqual(decoded(layout, succeeded(encoded)), relation)
		c.note(layout.payload.length === 0 ? "a set" : "a function")
		const position = new Map(
			Arr.map(odometer(layout.key), (point, at) => [pointKey(point), at] as const)
		)
		const positions = Arr.map(stated, (tuple) => defined(position.get(pointKey(tuple.key))))
		if (Arr.some(positions, (at, n) => n > 0 && at < defined(positions[n - 1]))) {
			c.note("rows out of index order")
		}
	})

/** What a payload space reached: a set, an empty one, or one past 2^53 points. */
export type Payload = "a set" | "an empty payload space" | "a payload space past 2^53 points"

/** A payload space's coordinate sizes: none to six coordinates, each of no code, a few, or up to a roster's whole code space. */
export const payloadSizes: Gen<ReadonlyArray<number>> = array(
	weighted([
		[1, constant(0)],
		[3, int(1, 9)],
		[2, int(1, 32_768)]
	]),
	{ min: 0, max: 6 }
)

/**
 * A payload space of six coordinates, each of up to a roster's whole code space: the space a case aimed past 2^53
 * points draws, whose sizes' binary lengths sum past 53 but where the drawn sizes are small.
 */
export const widePayloadSizes: Gen<ReadonlyArray<number>> = array(int(1, 32_768), {
	min: 6,
	max: 6
})

/**
 * Past the box, at payload spaces of up to six coordinates of up to 32,768 codes (a roster's whole code space), a
 * constant states its payload space's points exactly, past 2^53, and 1 for a space of no point, which holds no row.
 * Oracle: bigint's own product.
 */
export const exact = (sizes: ReadonlyArray<number>, c: Case<Payload>) =>
	Effect.sync(() => {
		const points = Arr.reduce(sizes, 1n, (product, n) => product * BigInt(n))
		const encoded = succeeded(constantOf({ key: [1], payload: sizes }, []))
		assert.equal(encoded.points, points === 0n ? 1n : points)
		if (sizes.length === 0) {
			c.note("a set")
		}
		if (points === 0n) {
			c.note("an empty payload space")
		}
		if (points > 2n ** 53n) {
			c.note("a payload space past 2^53 points")
		}
	})

/** Where a roster's removals left holes, and whether it grew past one. */
export type Holes =
	| "no hole"
	| "a leading hole"
	| "an inner hole"
	| "a trailing hole"
	| "growth past a hole"

/** A roster of `codes` handles declared once, then again with the live ones of `live` (a bit mask) and `appended` new. */
interface Pattern {
	readonly codes: number
	readonly live: number
	readonly appended: number
}

/** Every roster of 1 to 5 codes under every hole pattern that leaves a handle live, grown by 0 to 2 handles: 171. */
export const patterns: Gen<Pattern> = (s) => {
	const codes = s.draw(int(1, 5))
	return { codes, live: s.draw(int(1, 2 ** codes - 1)), appended: s.draw(int(0, 2)) }
}

/**
 * A roster numbers its first declaration 0 to n - 1; declaring only the handles a mask keeps leaves a hole at every
 * other code and keeps the rest; new handles take the codes past every code minted, never a hole, both beside the
 * removals and in a later declaration over the holes they left; and its constant reads each code live exactly where a
 * handle holds it, and absent past either end. Oracle: the pattern drawn.
 */
export const holePattern = ({ codes, live, appended }: Pattern, c: Case<Holes>) =>
	Effect.sync(() => {
		const handles = nonEmpty(Array.from({ length: codes }, (_, code) => `h${code}`))
		const first = succeeded(rosterCodes([], new Map(), { order: "ordered", handles }))
		assert.deepEqual(
			first,
			Arr.map(handles, (handle): CodeSlot => ({ kind: "live", handle }))
		)
		const isLive = (code: number): boolean => ((live >> code) & 1) === 1
		const kept = Arr.filter(handles, (_, code) => isLive(code))
		const added = Array.from({ length: appended }, (_, n) => `a${n}`)
		const next = succeeded(
			rosterCodes(first, new Map(), { order: "ordered", handles: nonEmpty([...kept, ...added]) })
		)
		const expected: RosterCodes = [
			...Arr.map(handles, (handle, code): CodeSlot =>
				isLive(code) ? { kind: "live", handle } : { kind: "hole" }
			),
			...Arr.map(added, (handle): CodeSlot => ({ kind: "live", handle }))
		]
		assert.deepEqual(next, expected)
		const grown = succeeded(
			rosterCodes(next, new Map(), {
				order: "ordered",
				handles: nonEmpty([
					...Arr.flatMap(next, (slot) => (slot.kind === "live" ? [slot.handle] : [])),
					"b0"
				])
			})
		)
		assert.deepEqual(
			grown,
			[...expected, { kind: "live", handle: "b0" }],
			"a later handle past every hole"
		)
		/** The roster's live codes as a constant over its one coordinate, its code space, with no payload. */
		const liveCodes = succeeded(
			constantOf(
				{ key: [next.length], payload: [] },
				Arr.flatMap(next, (slot, code) =>
					slot.kind === "live" ? [{ key: [code], payload: [] }] : []
				)
			)
		)
		const held = oracleCells(liveCodes)
		for (let code = 0; code < next.length + 2; code += 1) {
			const slot = next[code]
			assert.equal(
				payloadAt(held, undefined, BigInt(code)),
				slot?.kind === "live" ? 0n : undefined,
				`code ${code}`
			)
		}
		const holes = Arr.filter(
			Array.from({ length: codes }, (_, code) => code),
			(code) => !isLive(code)
		)
		if (holes.length === 0) {
			c.note("no hole")
		}
		if (holes.includes(0)) {
			c.note("a leading hole")
		}
		if (holes.includes(codes - 1)) {
			c.note("a trailing hole")
		}
		if (Arr.some(holes, (code) => code > 0 && code < codes - 1)) {
			c.note("an inner hole")
		}
		if (holes.length > 0 && appended > 0) {
			c.note("growth past a hole")
		}
	})

/** What a roster's declaration history held: each command, and a refused reorder. */
export type Declaration =
	| "a removal"
	| "a rename"
	| "a growth"
	| "a name used again"
	| "a name renamed away and declared again"
	| "a reorder"
	| "an unordered roster declared out of its codes' order"
	| "an unordered roster growing past a reorder"

/** What a declared handle stands for: a previous handle kept, a previous handle renamed, or a new handle. */
type Was =
	| { readonly kind: "kept"; readonly previous: string }
	| { readonly kind: "renamed"; readonly previous: string }
	| { readonly kind: "new" }

/** A handle a declaration states, and what it was before. */
interface Declared {
	readonly handle: string
	readonly was: Was
}

/** One declaration of the roster: its handles in declared order, and the renames declared beside it. */
interface Step {
	readonly declared: NonEmptyReadonlyArray<Declared>
	readonly renames: ReadonlyArray<readonly [from: string, to: string]>
}

/** A roster's declarations under one order (ir/scalar.ts RosterOrder), which each of them states. */
export interface History {
	readonly order: RosterOrder
	readonly steps: ReadonlyArray<Step>
}

/** The names a roster's handles are drawn from. */
const pool = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"] as const

/** One of `names`, which holds at least one. */
const oneOf =
	(names: ReadonlyArray<string>): Gen<string> =>
	(s) =>
		defined(names[s.draw(int(0, names.length - 1))])

/**
 * A roster's declarations under one order, each from the handles the one before left live: some kept, some renamed to
 * a name no handle holds, some dropped, and new names appended that no live handle holds but one renamed away. An
 * ordered roster's declaration may swap two neighbours, the named invalid case, and its history ends at the first that
 * does; an unordered roster's may list its handles in any order, which is no invalid case, and its history goes on.
 */
export const history: Gen<History> = (s) => {
	const order = s.draw(element(rosterOrders))
	const steps: Array<Step> = []
	let live: ReadonlyArray<string> = []
	const count = s.draw(int(1, 4))
	for (let n = 0; n < count; n += 1) {
		const taken = new Set(live)
		const declared: Array<Declared> = []
		const renames: Array<readonly [string, string]> = []
		for (const handle of s.draw(subarray(live))) {
			const free = Arr.filter(pool, (name) => !taken.has(name))
			if (
				free.length > 0 &&
				s.draw(
					weighted([
						[3, constant(false)],
						[1, constant(true)]
					])
				)
			) {
				const to = s.draw(oneOf(free))
				taken.add(to)
				renames.push([handle, to])
				declared.push({ handle: to, was: { kind: "renamed", previous: handle } })
			} else {
				declared.push({ handle, was: { kind: "kept", previous: handle } })
			}
		}
		const away = new Set(Arr.map(renames, ([from]) => from))
		const blocked = new Set([
			...Arr.filter(live, (name) => !away.has(name)),
			...Arr.map(renames, ([, to]) => to)
		])
		const additions = s.draw(int(declared.length === 0 ? 1 : 0, 2))
		for (let added = 0; added < additions; added += 1) {
			const free = Arr.filter(pool, (name) => !blocked.has(name))
			const handle = s.draw(oneOf(free))
			blocked.add(handle)
			declared.push({ handle, was: { kind: "new" } })
		}
		const swap =
			declared.length >= 2 &&
			s.draw(
				weighted([
					[5, constant(false)],
					[1, constant(true)]
				])
			)
		if (swap) {
			const at = s.draw(int(0, declared.length - 2))
			const [left, right] = [defined(declared[at]), defined(declared[at + 1])]
			declared[at] = right
			declared[at + 1] = left
		}
		const listed =
			order === "unordered" && s.draw(boolean)
				? s.draw(shuffled(declared, { min: declared.length, max: declared.length }))
				: declared
		steps.push({ declared: nonEmpty(listed), renames })
		if (swap && order === "ordered") {
			break
		}
		live = Arr.map(listed, (d) => d.handle)
	}
	return { order, steps }
}

/**
 * Through a history of declarations, each handle keeps its code across renames, new handles take the codes past every
 * code minted, in the order they are declared, and each removed handle leaves a hole; a declaration of an ordered
 * roster that puts two handles out of their codes' order is refused with the first such pair, and an unordered
 * roster's never is. Oracle: the codes each declared handle was drawn to stand for.
 */
export const histories = ({ order, steps }: History, c: Case<Declaration>) =>
	Effect.sync(() => {
		let codes: RosterCodes = []
		let reordered = false
		const used = new Set<string>()
		for (const step of steps) {
			const codeOf = new Map(
				Arr.flatMap(codes, (slot, code) =>
					slot.kind === "live" ? [[slot.handle, code] as const] : []
				)
			)
			let minted = codes.length
			const claimed = Arr.map(step.declared, (d) => {
				if (d.was.kind === "new") {
					minted += 1
					return minted - 1
				}
				return defined(codeOf.get(d.was.previous))
			})
			const handles = Arr.map(step.declared, (d) => d.handle)
			const result = rosterCodes(codes, new Map(step.renames), {
				order,
				handles: nonEmpty(handles)
			})
			const inversion = Arr.findFirstIndex(
				claimed,
				(code, at) => at > 0 && code < defined(claimed[at - 1])
			)
			if (Option.isSome(inversion) && order === "ordered") {
				assert.deepEqual(failed(result), {
					earlier: defined(handles[inversion.value - 1]),
					later: defined(handles[inversion.value])
				})
				c.note("a reorder")
				return
			}
			if (Option.isSome(inversion)) {
				c.note("an unordered roster declared out of its codes' order")
			}
			if (reordered && minted > codes.length) {
				c.note("an unordered roster growing past a reorder")
			}
			reordered = reordered || Option.isSome(inversion)
			const holderOf = new Map(
				Arr.map(claimed, (code, at) => [code, defined(handles[at])] as const)
			)
			const expected = Array.from({ length: minted }, (_, code): CodeSlot => {
				const handle = holderOf.get(code)
				return handle === undefined ? { kind: "hole" } : { kind: "live", handle }
			})
			const next = succeeded(result)
			assert.deepEqual(next, expected)
			if (codeOf.size > step.declared.length - (minted - codes.length)) {
				c.note("a removal")
			}
			if (step.renames.length > 0) {
				c.note("a rename")
			}
			if (minted > codes.length) {
				c.note("a growth")
			}
			if (Arr.some(step.declared, (d) => d.was.kind === "new" && used.has(d.handle))) {
				c.note("a name used again")
			}
			const away = new Set(Arr.map(step.renames, ([from]) => from))
			if (Arr.some(step.declared, (d) => d.was.kind === "new" && away.has(d.handle))) {
				c.note("a name renamed away and declared again")
			}
			for (const handle of handles) {
				used.add(handle)
			}
			for (const [from] of step.renames) {
				used.add(from)
			}
			codes = next
		}
	})

/** How a side was keyed: by a declared key, by all its fields, or by the smallest of several it contains. */
export type Keyed =
	| "keyed by a declared key"
	| "keyed by all its fields"
	| "the smallest of several contained keys"
	| "the first of tied keys"
	| "a key in another order than the terms"
	| "a projection's repeats are one row"

/** A side's heading: its fields, its declared keys, and the terms it selects. */
interface Heading {
	readonly fields: NonEmptyReadonlyArray<string>
	readonly keys: ReadonlyArray<NonEmptyReadonlyArray<string>>
	readonly terms: NonEmptyReadonlyArray<string>
}

/**
 * Every heading of one to three fields with zero to two declared keys, each key and the side's terms any ordered
 * choice of its fields: 3,702 sides.
 */
export const headings: Gen<Heading> = (s) => {
	const fields = nonEmpty(["f0", "f1", "f2"].slice(0, s.draw(int(1, 3))))
	const ordered: Gen<NonEmptyReadonlyArray<string>> = (t) =>
		nonEmpty(t.draw(shuffled(fields, { min: 1, max: fields.length })))
	return {
		fields,
		keys: s.draw(array(ordered, { min: 0, max: 2 })),
		terms: s.draw(ordered)
	}
}

/** The rows of a heading over two codes a field that hold every declared key and the heading: the first of each clash kept. */
const rowsOf = (fields: ReadonlyArray<string>, keys: ReadonlyArray<ReadonlyArray<string>>) => {
	const held = Arr.map([...keys, fields], (key) => Arr.map(key, (field) => fields.indexOf(field)))
	const rows: Array<ReadonlyArray<number>> = []
	for (const row of odometer(Arr.map(fields, () => 2))) {
		if (
			!Arr.some(rows, (kept) =>
				Arr.some(held, (key) => Arr.every(key, (at) => kept[at] === row[at]))
			)
		) {
			rows.push(row)
		}
	}
	return rows
}

/**
 * A side is keyed by the smallest declared key whose fields it contains, the first declared among the smallest, in
 * that key's order, or else by all its terms; its payload is its other terms in term order; its rows are its
 * relation's projected onto them, a set: one row per key, so two rows the projection makes equal are one; and they
 * never collide. Oracle: that rule restated as a checker, and a naive projection deduplicated by its key.
 */
export const keying = ({ fields, keys, terms }: Heading, c: Case<Keyed>) =>
	Effect.sync(() => {
		const rows = rowsOf(fields, keys)
		const contained = Arr.filter(keys, (key) => Arr.every(key, (field) => terms.includes(field)))
		const shortest = Arr.reduce(contained, Number.POSITIVE_INFINITY, (n, key) =>
			Math.min(n, key.length)
		)
		const expected = Option.getOrElse(
			Arr.findFirst(contained, (key) => key.length === shortest),
			() => terms
		)
		const side = sideOf({ fields, keys }, terms, rows, String)
		assert.deepEqual(side.key, expected)
		assert.deepEqual(
			side.payload,
			Arr.filter(terms, (term) => !expected.includes(term))
		)
		const valueOf = (row: ReadonlyArray<number>, field: string): number =>
			defined(row[fields.indexOf(field)])
		const projected = Arr.map(rows, (row) => ({
			key: Arr.map(expected, (field) => valueOf(row, field)),
			payload: Arr.map(side.payload, (field) => valueOf(row, field))
		}))
		const keyText = (key: ReadonlyArray<number>): string => Arr.join(Arr.map(key, String), ",")
		const byKey = new Map(Arr.map(projected, (row) => [keyText(row.key), row] as const))
		assert.deepEqual(
			Arr.sort(
				Arr.map([...side.rows.values()], (row) => keyText(row.key)),
				Order.String
			),
			Arr.sort([...byKey.keys()], Order.String),
			"one row per key of the projection"
		)
		for (const row of side.rows.values()) {
			assert.deepEqual(row, defined(byKey.get(keyText(row.key))))
		}
		if (projected.length > byKey.size) {
			c.note("a projection's repeats are one row")
		}
		const encoded = succeeded(
			constantOf(
				{ key: nonEmpty(Arr.map(side.key, () => 2)), payload: Arr.map(side.payload, () => 2) },
				[...side.rows.values()]
			)
		)
		if (contained.length === 0) {
			assert.equal(encoded.points, 1n, "a side keyed by all its fields is a set")
			c.note("keyed by all its fields")
		} else {
			c.note("keyed by a declared key")
		}
		const smallest = Arr.filter(contained, (key) => key.length === shortest)
		if (smallest.length < contained.length) {
			c.note("the smallest of several contained keys")
		}
		if (smallest.length >= 2) {
			c.note("the first of tied keys")
		}
		const inTermOrder = Arr.filter(terms, (term) => expected.includes(term))
		if (contained.length > 0 && Arr.some(expected, (field, at) => field !== inTermOrder[at])) {
			c.note("a key in another order than the terms")
		}
	})

/** How a constant was edited: a cell made present or absent, a payload changed, a move or a swap. */
export type Edited =
	| "a cell made present"
	| "a cell made absent"
	| "a payload changed"
	| "a cell moved"
	| "two cells swapped"
	| "the key space grown"
	| "the payload space grown"
	| "another layout, the same constant"

/** Every closed relation over a key of at most 3 points and a payload of none, 2 or 3 codes: 858 constants. */
export const small = relationIn(3, [[], [2], [3]])

/** The constant of `rows` over `layout`, which holds the key. */
const encode = (layout: Product, rows: ReadonlyArray<Tuple>): Constant =>
	succeeded(constantOf(layout, rows))

/** A constant's digests: its cells', and its payloads' where it installs them. */
const digestOf = (c: Constant): string =>
	`${cellsDigestOf(
		c.cells,
		Arr.map(c.entries, (e) => e.index)
	)}/${
		c.points > 1n
			? payloadsDigestOf(
					c.points,
					Arr.map(c.entries, (e) => e.payload)
				)
			: "none"
	}`

/**
 * Content addressing: the digest is a function of the constant alone (its rows restated in reverse and repeated, or
 * over another layout of the same cells and payload codes, a leading key coordinate of one code, name one function), and every edit of a cell (a cell made present, made
 * absent, or given another payload), every cell moved to an absent key, every two cells of different payloads
 * swapped, and every growth of the key space or of the payload space names another: a digest blind to where a cell lies would name a changed
 * relation's function by its old name. Oracle: the edits enumerated, each against the digest of the unedited
 * constant.
 */
export const addressed = ({ layout, rows }: Boxed, c: Case<Edited>) =>
	Effect.sync(() => {
		const original = encode(layout, rows)
		const digest = digestOf(original)
		assert.equal(
			digestOf(encode(layout, [...Arr.reverse(rows), ...rows])),
			digest,
			"the rows' order and repeats"
		)
		const payloads = odometer(layout.payload)
		const cellAt = new Map(Arr.map(rows, (row) => [pointKey(row.key), row] as const))
		for (const point of odometer(layout.key)) {
			const held = cellAt.get(pointKey(point))
			const others = Arr.filter(rows, (row) => row !== held)
			for (const payload of payloads) {
				if (held === undefined || pointKey(held.payload) !== pointKey(payload)) {
					c.note(held === undefined ? "a cell made present" : "a payload changed")
					assert.notEqual(
						digestOf(encode(layout, [...others, { key: point, payload }])),
						digest,
						`the cell at ${pointKey(point)}`
					)
				}
			}
			if (held !== undefined) {
				c.note("a cell made absent")
				assert.notEqual(digestOf(encode(layout, others)), digest, `the cell at ${pointKey(point)}`)
			}
		}
		for (const row of rows) {
			const others = Arr.filter(rows, (other) => other !== row)
			for (const point of odometer(layout.key)) {
				const there = cellAt.get(pointKey(point))
				if (there === undefined) {
					c.note("a cell moved")
					assert.notEqual(
						digestOf(encode(layout, [...others, { key: point, payload: row.payload }])),
						digest,
						`the cell at ${pointKey(row.key)} moved to ${pointKey(point)}`
					)
				} else if (pointKey(there.payload) !== pointKey(row.payload)) {
					c.note("two cells swapped")
					const rest = Arr.filter(others, (other) => other !== there)
					assert.notEqual(
						digestOf(
							encode(layout, [
								...rest,
								{ key: point, payload: row.payload },
								{ key: row.key, payload: there.payload }
							])
						),
						digest,
						`the cells at ${pointKey(row.key)} and ${pointKey(point)} swapped`
					)
				}
			}
		}
		const grown: Product = {
			key: nonEmpty([...layout.key.slice(0, -1), defined(layout.key.at(-1)) + 1]),
			payload: layout.payload
		}
		if (Arr.every(layout.key, (size) => size > 0)) {
			c.note("the key space grown")
			assert.notEqual(digestOf(encode(grown, rows)), digest, "one more cell")
		}
		if (layout.payload.length === 1) {
			c.note("the payload space grown")
			const wider: Product = { key: layout.key, payload: [defined(layout.payload[0]) + 1] }
			assert.notEqual(digestOf(encode(wider, rows)), digest, "one more payload code")
			c.note("another layout, the same constant")
			const led: Product = { key: [1, ...layout.key], payload: layout.payload }
			assert.equal(
				digestOf(
					encode(
						led,
						Arr.map(rows, (row) => ({ key: [0, ...row.key], payload: row.payload }))
					)
				),
				digest,
				"a constant names its function, not its layout"
			)
		}
	})
