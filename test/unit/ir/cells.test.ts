/**
 * The cells encoder (ir/cells.ts), every rule against an oracle that shares none of its arithmetic.
 *
 * - The naive tuple-set model: a relation is the list of its tuples in the odometer's order of its key space, and a
 *   constant is decoded by reading every cell of its bit text the way PostgreSQL's substring reads it, each present cell
 *   mapped back to its key and payload by the odometer. decode ∘ encode = id over every closed relation of a box.
 * - The odometer: every point of a space counted in row-major order, which the mixed-radix index must number
 *   bijectively, and which no out-of-range digit may reach, the alias (a digit past its radix carrying into its
 *   neighbour, 400 as 37 at PostgreSQL's scale) among them.
 * - The slot list: a fin coordinate's slots listed owner by owner, whose positions its prefix offsets must be.
 * - The intent a roster's declarations were drawn with, and the spec of a side's key restated as a checker.
 *
 * Where a space is small it is enumerated whole (exhaust), and the bound is in each generator's documentation; where it
 * is not (16-bit codes, payload spaces past 2^53, declaration histories), it is searched (explore).
 */
import { describe, it } from "@effect/vitest"
import { type Case, drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
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
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, String as Str } from "effect"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { compareNumbers } from "#compiler/core/order.ts"
import {
	cellWidth,
	type CodeSlot,
	type Constant,
	constantDigestOf,
	constantOf,
	dictionaryOf,
	finDigit,
	finSize,
	finSpace,
	type CellLayout,
	rosterCodes,
	type RosterCodes,
	rowMajorIndex,
	sideOf,
	spaceSize,
	type Tuple
} from "#compiler/ir/cells.ts"
import { assert, defined, failed, nonEmpty, succeeded } from "#test/support/assert.ts"
import { bitText } from "#test/support/closed/bit-text.ts"
import { caseHang } from "#test/support/limits.ts"

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
 * PostgreSQL's substring(bits FROM start FOR length) on a bit string: 1-based, and total, the bits of the range that lie
 * inside the string, the empty string for a range wholly outside it.
 */
const substring = (bits: string, start: number, length: number): string => {
	const from = Math.max(start, 1)
	const to = Math.min(start + length, bits.length + 1)
	return from >= to ? "" : Str.slice(from - 1, to - 1)(bits)
}

/** A cell as a domain reads it, substring(R FROM index * w + 1 FOR w)::int4, the empty string's value being 0. */
const readCell = (bits: string, width: number, index: number): bigint => {
	const cell = substring(bits, index * width + 1, width)
	return cell === "" ? 0n : BigInt(`0b${cell}`)
}

/**
 * The naive decoder: every cell of a constant's text read as PostgreSQL reads it, each present cell's index mapped back
 * to its key by the odometer of the key space and its value 1 + c to the payload at position c of the payload space's
 * odometer. Its tuples come in index order.
 */
const decoded = (layout: CellLayout, text: string, width: number): ReadonlyArray<Tuple> => {
	const payloads = odometer(layout.payload)
	return Arr.flatMap(odometer(layout.key), (key, index): ReadonlyArray<Tuple> => {
		const cell = readCell(text, width, index)
		return cell === 0n
			? []
			: [
					{
						key,
						payload: defined(payloads[Number(cell) - 1], `cell ${index} holds 1 + a payload code`)
					}
				]
	})
}

/** The bits that hold the largest cell value of a payload space of `points` codes, 1 + (points - 1): its binary length. */
const bitsToHold = (points: bigint): number => (points === 0n ? 0 : points.toString(2).length)

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
	readonly layout: CellLayout
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

describe("the row-major index", () => {
	type Shape = "one coordinate" | "three coordinates" | "an empty coordinate" | "an aliasing digit"

	/**
	 * Every key shape of one to three coordinates of 0 to 5 codes each: 258 shapes, every point of each, and at every
	 * point every coordinate's digit moved just outside its range (-1, its size, its size + 1, twice its size + 1, a
	 * fraction).
	 */
	const shapes: Gen<NonEmptyReadonlyArray<number>> = (s) => {
		const arity = s.draw(int(1, 3))
		return nonEmpty(Array.from({ length: arity }, () => s.draw(int(0, 5))))
	}

	/**
	 * The index numbers the in-range points bijectively in the odometer's order, and names no point for a digit outside
	 * its coordinate: oracle, the odometer, and for the alias Horner's rule run without the range proof, whose index
	 * would land on another in-range point.
	 */
	const bijection = (sizes: NonEmptyReadonlyArray<number>, c: Case<Shape>) =>
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

	it.effect(
		"is a bijection from the in-range digits onto the odometer's count, and aliases no digit out of range",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/ir/cells-index",
						generator: shapes,
						literal: Formatter.format,
						limit: 258,
						coverage: requiredInSpace<Shape>([
							"one coordinate",
							"three coordinates",
							"an empty coordinate",
							"an aliasing digit"
						]),
						caseHang
					},
					bijection
				)
			)
	)
})

describe("a fin coordinate", () => {
	type Owners = "an owner with no slot" | "several owners with slots" | "no owner"

	/** Every closed owner roster of 0 to 4 owners, each holding 0 to 3 slots: 341 coordinates. */
	const owners: Gen<ReadonlyArray<number>> = (s) => {
		const count = s.draw(int(0, 4))
		return Array.from({ length: count }, () => s.draw(int(0, 3)))
	}

	/**
	 * The prefix offsets are dense: slot `at` of owner o is the position of (o, at) in the list of every owner's slots,
	 * owner by owner, so the codes are exactly 0 to the coordinate's size - 1, each once; no code names a slot an owner
	 * lacks. Oracle: that list.
	 */
	const dense = (counts: ReadonlyArray<number>, c: Case<Owners>) =>
		Effect.sync(() => {
			const slots = Arr.flatMap(counts, (count, owner) =>
				Array.from({ length: count }, (_, at) => [owner, at] as const)
			)
			const space = finSpace(counts)
			assert.equal(finSize(space), slots.length)
			for (const [code, [owner, at]] of slots.entries()) {
				assert.equal(finDigit(space, owner, at), code, `slot ${at} of owner ${owner}`)
			}
			for (let owner = -1; owner <= counts.length; owner += 1) {
				const count = counts[owner] ?? 0
				for (const at of [-1, count, count + 1, 0.5]) {
					assert.equal(finDigit(space, owner, at), undefined, `slot ${at} of owner ${owner}`)
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

	it.effect(
		"numbers each owner's slots densely after every earlier owner's, and names no slot an owner lacks",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/ir/cells-fin",
						generator: owners,
						literal: Formatter.format,
						limit: 341,
						coverage: requiredInSpace<Owners>([
							"an owner with no slot",
							"several owners with slots",
							"no owner"
						]),
						caseHang
					},
					dense
				)
			)
	)
})

describe("a relation's string of cells", () => {
	type Relation =
		| "a set"
		| "a function"
		| "an empty key space"
		| "an empty payload space"
		| "every cell present"
		| "three key coordinates"

	/**
	 * The box: every closed relation over a key of one to three coordinates whose sizes multiply to at most 4 (a
	 * coordinate of no code among them), and a payload of none (a set, w = 1), one coordinate of 0, 1, 2 or 3 codes
	 * (w = 0, 1, 2, 2) or two of 2 (w = 3): 11,915 relations.
	 */
	const box = relationIn(4, [[], [0], [1], [2], [3], [2, 2]])

	/**
	 * decode ∘ encode = id: the naive decoder reads back exactly the relation's tuples from its text, which is exactly
	 * cells · w bits, w the fewest bits that hold 1 + the largest payload code; a read past either end is absent; and the
	 * text is refused one bit short of its length. Oracle: the naive tuple-set model and PostgreSQL's substring.
	 */
	const roundTrip = ({ layout, rows }: Boxed, c: Case<Relation>) =>
		Effect.sync(() => {
			const encoded = succeeded(constantOf(layout, rows))
			const cells = odometer(layout.key).length
			const width = bitsToHold(BigInt(odometer(layout.payload).length))
			assert.equal(encoded.cells, BigInt(cells))
			assert.equal(encoded.width, width, "the fewest bits that hold 1 + the largest payload code")
			const bits = cells * width
			const text = succeeded(bitText(encoded, bits))
			assert.equal(text.length, bits)
			if (bits > 0) {
				assert.deepEqual(failed(bitText(encoded, bits - 1)), {
					kind: "stringLength",
					limit: bits - 1,
					needed: bits
				})
			}
			assert.deepEqual(decoded(layout, text, width), rows, "decode ∘ encode = id")
			for (const outside of [-2, -1, cells, cells + 1]) {
				assert.equal(readCell(text, width, outside), 0n, `the cell at ${outside}`)
			}
			if (layout.payload.length === 0) {
				c.note("a set")
			}
			if (width >= 2) {
				c.note("a function")
			}
			if (cells === 0) {
				c.note("an empty key space")
			}
			if (width === 0) {
				c.note("an empty payload space")
			}
			if (cells > 0 && rows.length === cells) {
				c.note("every cell present")
			}
			if (layout.key.length === 3) {
				c.note("three key coordinates")
			}
		})

	it.effect(
		"decodes back to exactly its tuples, in cells · w bits, reading absent past either end",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/ir/cells-relations",
						generator: box,
						literal: Formatter.format,
						limit: 11_915,
						coverage: requiredInSpace<Relation>([
							"a set",
							"a function",
							"an empty key space",
							"an empty payload space",
							"every cell present",
							"three key coordinates"
						]),
						caseHang
					},
					roundTrip
				)
			)
	)

	type Stated =
		| "rows out of index order"
		| "a row stated twice"
		| "a key collision"
		| "a set"
		| "a function"

	/** A relation's rows as a caller states them: in any order, some repeated, and in a named invalid variant a key collision. */
	interface Statement {
		readonly layout: CellLayout
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
	const statement: Gen<Statement> = (s) => {
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
	const setOfRows = ({ layout, relation, stated }: Statement, c: Case<Stated>) =>
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
			const width = succeeded(encoded).width
			const text = succeeded(bitText(succeeded(encoded), Number(succeeded(encoded).cells) * width))
			assert.deepEqual(decoded(layout, text, width), relation)
			c.note(layout.payload.length === 0 ? "a set" : "a function")
			const position = new Map(
				Arr.map(odometer(layout.key), (point, at) => [pointKey(point), at] as const)
			)
			const positions = Arr.map(stated, (tuple) => defined(position.get(pointKey(tuple.key))))
			if (Arr.some(positions, (at, n) => n > 0 && at < defined(positions[n - 1]))) {
				c.note("rows out of index order")
			}
		})

	it.effect(
		"is the same for its rows in any order and repeated, and refuses two payloads at one key",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/ir/cells-rows",
						draw: drawn(statement),
						literal: Formatter.format,
						coverage: required<Stated>(
							[
								"rows out of index order",
								"a row stated twice",
								"a key collision",
								"a set",
								"a function"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					setOfRows
				)
			)
	)
})

describe("a cell's width", () => {
	type Payload = "a set" | "an empty payload space" | "a payload space past 2^53 points"

	/**
	 * Past the box, at payload spaces of up to six coordinates of up to 32,768 codes (a roster's whole code space), the
	 * width is the binary length of the largest cell value, exact past 2^53. Oracle: bigint's own binary numeral.
	 */
	const exact = (sizes: ReadonlyArray<number>, c: Case<Payload>) =>
		Effect.sync(() => {
			const points = Arr.reduce(sizes, 1n, (product, n) => product * BigInt(n))
			assert.equal(cellWidth(points), bitsToHold(points))
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

	it.effect("is the binary length of 1 + the largest payload code, exactly, past 2^53", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/ir/cells-width",
					draw: drawn(
						array(
							weighted([
								[1, constant(0)],
								[3, int(1, 9)],
								[2, int(1, 32_768)]
							]),
							{ min: 0, max: 6 }
						)
					),
					literal: Formatter.format,
					coverage: required<Payload>(
						["a set", "an empty payload space", "a payload space past 2^53 points"],
						{
							cases: 200,
							sense: notesOnly
						}
					),
					kept: [],
					runs: 300,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				exact
			)
		)
	)
})

describe("a roster's codes", () => {
	type Holes =
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
	const patterns: Gen<Pattern> = (s) => {
		const codes = s.draw(int(1, 5))
		return { codes, live: s.draw(int(1, 2 ** codes - 1)), appended: s.draw(int(0, 2)) }
	}

	/**
	 * A roster numbers its first declaration 0 to n - 1; declaring only the handles a mask keeps leaves a hole at every
	 * other code and keeps the rest; new handles take the codes past every code minted, never a hole; and its constant
	 * reads each code live exactly where a handle holds it, and absent past either end. Oracle: the pattern drawn.
	 */
	const holePattern = ({ codes, live, appended }: Pattern, c: Case<Holes>) =>
		Effect.sync(() => {
			const handles = nonEmpty(Array.from({ length: codes }, (_, code) => `h${code}`))
			const first = succeeded(rosterCodes([], new Map(), handles))
			assert.deepEqual(
				first,
				Arr.map(handles, (handle): CodeSlot => ({ kind: "live", handle }))
			)
			const isLive = (code: number): boolean => ((live >> code) & 1) === 1
			const kept = Arr.filter(handles, (_, code) => isLive(code))
			const added = Array.from({ length: appended }, (_, n) => `a${n}`)
			const next = succeeded(rosterCodes(first, new Map(), nonEmpty([...kept, ...added])))
			const expected: RosterCodes = [
				...Arr.map(handles, (handle, code): CodeSlot =>
					isLive(code) ? { kind: "live", handle } : { kind: "hole" }
				),
				...Arr.map(added, (handle): CodeSlot => ({ kind: "live", handle }))
			]
			assert.deepEqual(next, expected)
			/** The roster's live codes as a constant over its one coordinate, its code space, with no payload. */
			const liveCodes = succeeded(
				constantOf(
					{ key: [next.length], payload: [] },
					Arr.flatMap(next, (slot, code) =>
						slot.kind === "live" ? [{ key: [code], payload: [] }] : []
					)
				)
			)
			const text = succeeded(bitText(liveCodes, next.length))
			for (let code = -2; code < next.length + 2; code += 1) {
				const slot = next[code]
				assert.equal(readCell(text, 1, code), slot?.kind === "live" ? 1n : 0n, `code ${code}`)
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

	it.effect(
		"leave a hole for each removed handle, never reused, under every hole pattern of up to five codes",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/ir/cells-roster-holes",
						generator: patterns,
						literal: Formatter.format,
						limit: 171,
						coverage: requiredInSpace<Holes>([
							"no hole",
							"a leading hole",
							"an inner hole",
							"a trailing hole",
							"growth past a hole"
						]),
						caseHang
					},
					holePattern
				)
			)
	)

	type Declaration =
		| "a removal"
		| "a rename"
		| "a growth"
		| "a name used again"
		| "a name renamed away and declared again"
		| "a reorder"

	/** What a declared handle stands for: a previous handle kept, a previous handle renamed, or a new handle. */
	type Was =
		| { readonly kind: "kept"; readonly previous: string }
		| { readonly kind: "renamed"; readonly previous: string }
		| { readonly kind: "new" }

	interface Declared {
		readonly handle: string
		readonly was: Was
	}

	/** One declaration of the roster: its handles in declared order, and the renames declared beside it. */
	interface Step {
		readonly declared: NonEmptyReadonlyArray<Declared>
		readonly renames: ReadonlyArray<readonly [from: string, to: string]>
	}

	const pool = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"] as const

	/** One of `names`, which holds at least one. */
	const oneOf =
		(names: ReadonlyArray<string>): Gen<string> =>
		(s) =>
			defined(names[s.draw(int(0, names.length - 1))])

	/**
	 * A roster's declarations, each from the handles the one before left live: some kept, some renamed to a name no
	 * handle holds, some dropped, and new names appended that no live handle holds but one renamed away. A declaration
	 * may swap two neighbours, the named invalid case, and a history ends at the first that does.
	 */
	const history: Gen<ReadonlyArray<Step>> = (s) => {
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
			steps.push({ declared: nonEmpty(declared), renames })
			if (swap) {
				break
			}
			live = Arr.map(declared, (d) => d.handle)
		}
		return steps
	}

	/**
	 * Through a history of declarations, each handle keeps its code across renames, new handles take the codes past every
	 * code minted, each removed handle leaves a hole, and a declaration that puts two handles out of their codes' order is
	 * refused with the first such pair. Oracle: the codes each declared handle was drawn to stand for.
	 */
	const histories = (steps: ReadonlyArray<Step>, c: Case<Declaration>) =>
		Effect.sync(() => {
			let codes: RosterCodes = []
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
				const result = rosterCodes(codes, new Map(step.renames), nonEmpty(handles))
				const inversion = Arr.findFirstIndex(
					claimed,
					(code, at) => at > 0 && code < defined(claimed[at - 1])
				)
				if (Option.isSome(inversion)) {
					assert.deepEqual(failed(result), {
						earlier: defined(handles[inversion.value - 1]),
						later: defined(handles[inversion.value])
					})
					c.note("a reorder")
					return
				}
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

	it.effect(
		"keep each handle's code through renames, append new handles past every code minted, and refuse a reorder",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/ir/cells-roster",
						draw: drawn(history),
						literal: Formatter.format,
						coverage: required<Declaration>(
							[
								"a removal",
								"a rename",
								"a growth",
								"a name used again",
								"a name renamed away and declared again",
								"a reorder"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					histories
				)
			)
	)
})

describe("a side", () => {
	type Keyed =
		| "keyed by a declared key"
		| "keyed by all its fields"
		| "the smallest of several contained keys"
		| "the first of tied keys"
		| "a key in another order than the terms"
		| "a projection's repeats are one row"

	interface Heading {
		readonly fields: NonEmptyReadonlyArray<string>
		readonly keys: ReadonlyArray<NonEmptyReadonlyArray<string>>
		readonly terms: NonEmptyReadonlyArray<string>
	}

	/**
	 * Every heading of one to three fields with zero to two declared keys, each key and the side's terms any ordered
	 * choice of its fields: 3,702 sides.
	 */
	const headings: Gen<Heading> = (s) => {
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
	const keying = ({ fields, keys, terms }: Heading, c: Case<Keyed>) =>
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
				assert.equal(encoded.width, 1, "a side keyed by all its fields is a set")
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

	it.effect(
		"is keyed by the smallest declared key it contains, else by all its fields, and its rows never collide",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/ir/cells-side",
						generator: headings,
						literal: Formatter.format,
						limit: 3702,
						coverage: requiredInSpace<Keyed>([
							"keyed by a declared key",
							"keyed by all its fields",
							"the smallest of several contained keys",
							"the first of tied keys",
							"a key in another order than the terms",
							"a projection's repeats are one row"
						]),
						caseHang
					},
					keying
				)
			)
	)
})

describe("an open-typed field's dictionary", () => {
	type Order = "by value" | "by magnitude, ties merged"

	interface Column {
		readonly column: ReadonlyArray<number>
		readonly byMagnitude: boolean
	}

	/** Every column of 0 to 4 values from -2 to 2, under the numbers' order and under magnitude, which ties a value and its negation: 1,562. */
	const columns: Gen<Column> = (s) => ({
		column: Array.from({ length: s.draw(int(0, 4)) }, () => s.draw(int(-2, 2))),
		byMagnitude: s.draw(boolean)
	})

	/**
	 * The dictionary is the column's classes of tied values, one value each, ascending; each row's code is the position of
	 * its value's class. Oracle: the classes counted by a Set of each value's key under the order.
	 */
	const classes = ({ column, byMagnitude }: Column, c: Case<Order>) =>
		Effect.sync(() => {
			const keyOf = (value: number): number => (byMagnitude ? Math.abs(value) : value)
			const order = (a: number, b: number) => compareNumbers(keyOf(a), keyOf(b))
			const dictionary = dictionaryOf(column, order)
			assert.deepEqual(
				Arr.map(dictionary.values, keyOf),
				Arr.sort(Arr.fromIterable(new Set(Arr.map(column, keyOf))), Order.Number)
			)
			assert.equal(dictionary.codes.length, column.length)
			for (const [row, value] of column.entries()) {
				assert.equal(
					keyOf(defined(dictionary.values[defined(dictionary.codes[row])])),
					keyOf(value),
					`row ${row}`
				)
			}
			c.note(byMagnitude ? "by magnitude, ties merged" : "by value")
		})

	it.effect(
		"codes each row by its value's position among the column's distinct values, ascending, values the order ties being one",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/ir/cells-dictionary",
						generator: columns,
						literal: Formatter.format,
						limit: 1562,
						coverage: requiredInSpace<Order>(["by value", "by magnitude, ties merged"]),
						caseHang
					},
					classes
				)
			)
	)
})

describe("a constant's digest", () => {
	type Edited =
		| "a cell made present"
		| "a cell made absent"
		| "a payload changed"
		| "a cell moved"
		| "two cells swapped"
		| "the key space grown"
		| "another layout, the same constant"

	/** Every closed relation over a key of at most 3 points and a payload of none, 2 or 3 codes: 858 constants. */
	const small = relationIn(3, [[], [2], [3]])

	/** The constant of `rows` over `layout`, which holds the key. */
	const encode = (layout: CellLayout, rows: ReadonlyArray<Tuple>): Constant =>
		succeeded(constantOf(layout, rows))

	const digestOf = (c: Constant): string => constantDigestOf(c)

	/**
	 * Content addressing: the digest is a function of the constant alone (its rows restated in reverse and repeated, or
	 * over another layout of the same width, name one function), and every edit of a cell (a cell made present, made
	 * absent, or given another payload), every cell moved to an absent key, every two cells of different payloads
	 * swapped, and every growth of the key space names another: a digest blind to where a cell lies would name a changed
	 * relation's function by its old name. Oracle: the edits enumerated, each against the digest of the unedited
	 * constant.
	 */
	const addressed = ({ layout, rows }: Boxed, c: Case<Edited>) =>
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
					assert.notEqual(
						digestOf(encode(layout, others)),
						digest,
						`the cell at ${pointKey(point)}`
					)
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
			const grown: CellLayout = {
				key: nonEmpty([...layout.key.slice(0, -1), defined(layout.key.at(-1)) + 1]),
				payload: layout.payload
			}
			if (Arr.every(layout.key, (size) => size > 0)) {
				c.note("the key space grown")
				assert.notEqual(digestOf(encode(grown, rows)), digest, "one more cell")
			}
			if (
				layout.payload.length === 1 &&
				bitsToHold(BigInt(defined(layout.payload[0]) + 1)) === original.width
			) {
				c.note("another layout, the same constant")
				const wider: CellLayout = { key: layout.key, payload: [defined(layout.payload[0]) + 1] }
				assert.equal(
					digestOf(encode(wider, rows)),
					digest,
					"a constant names its function, not its layout"
				)
			}
		})

	it.effect(
		"names a constant by its content alone, and every edit of one cell, a move or a swap of two, by another",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/ir/cells-digest",
						generator: small,
						literal: Formatter.format,
						limit: 858,
						coverage: requiredInSpace<Edited>([
							"a cell made present",
							"a cell made absent",
							"a payload changed",
							"the key space grown",
							"another layout, the same constant",
							"a cell moved",
							"two cells swapped"
						]),
						caseHang
					},
					addressed
				)
			)
	)
})
