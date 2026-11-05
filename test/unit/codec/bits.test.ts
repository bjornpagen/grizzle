/**
 * Host bit strings (codec/bits.ts) against a naive model: a string is its length and the Set of its positions that hold
 * a 1, its text one character per position. Every operation is checked against the model's own Set algebra, and the
 * cell read against PostgreSQL's substring and int4 cast restated on the text.
 *
 * Where a space is small at the boundaries that matter it is enumerated whole: every string with at most two ones or at
 * most two zeros at each length beside a word's edges (0, 1, 31, 32, 33, 63, 64, 65), every string with one one or one
 * zero beside a Harley–Seal block's edges (255 to 257, 511 to 513, 543 to 545), every fold of up to four members over
 * rosters of up to four codes placed across a word's edge, and every one-hot string of three words under every cell
 * width. Random densities and lengths up to four blocks and a word are searched.
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
	oneOf,
	option,
	string,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, String as Str } from "effect"
import {
	add,
	and,
	andNot,
	type BitString,
	cell,
	count,
	empty,
	fromText,
	has,
	members,
	or,
	type Planes,
	planes,
	step,
	toText
} from "#compiler/codec/bits.ts"
import { assert, defined, throwsDefect } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** The naive model of a bit string. */
interface Model {
	readonly length: number
	readonly ones: ReadonlySet<number>
}

/** The model of a string's text: position k holds a 1 where its (k + 1)th character is `1`. */
const modelOf = (text: string): Model => ({
	length: text.length,
	ones: new Set(Arr.flatMap(Str.split("")(text), (character, k) => (character === "1" ? [k] : [])))
})

/** The model's text, one character per position. */
const textOf = (model: Model): string =>
	Arr.join(
		Array.from({ length: model.length }, (_, k) => (model.ones.has(k) ? "1" : "0")),
		""
	)

/** The union of sets, the empty set for none. */
const unionOf = (sets: ReadonlyArray<ReadonlySet<number>>): ReadonlySet<number> =>
	Arr.reduce(sets, new Set<number>(), (union: ReadonlySet<number>, set) => union.union(set))

/** The model's positions, ascending. */
const ascending = (ones: ReadonlySet<number>): ReadonlyArray<number> =>
	Arr.sort(Arr.fromIterable(ones), Order.Number)

/** The bits of a word. */
const wordBits = 32

/**
 * A string checked whole against its model: its text written back, its positions enumerated ascending, its count, and
 * every position's membership from a word before it to a word past it.
 */
const agrees = (bits: BitString, model: Model): void => {
	assert.equal(bits.length, model.length)
	assert.equal(bits.words.length, Math.ceil(model.length / wordBits))
	assert.equal(toText(bits), textOf(model))
	assert.deepEqual(members(bits), ascending(model.ones))
	assert.equal(count(bits), model.ones.size)
	for (let k = -wordBits - 1; k < model.length + wordBits + 1; k++) {
		assert.equal(has(bits, k), model.ones.has(k), `position ${k}`)
	}
}

/** The text of a string of `length` positions whose ones are `ones`, or whose zeros are when `dense`. */
const marked = (length: number, marks: ReadonlyArray<number>, dense: boolean): string =>
	Arr.join(
		Array.from({ length }, (_, k) => (marks.includes(k) === dense ? "0" : "1")),
		""
	)

describe("bit strings at a word's edges", () => {
	type Edge =
		| "no bits"
		| "a partial last word"
		| "whole words"
		| "a bit at a word's last position"
		| "a dense string"

	interface Marked {
		readonly length: number
		readonly marks: ReadonlyArray<number>
		readonly dense: boolean
	}

	/**
	 * Every string with at most two ones, and every string with at most two zeros, at each length beside a word's edges:
	 * 0, 1, 31, 32, 33, 63, 64 and 65 positions, 15,670 strings.
	 */
	const edges: Gen<Marked> = (s) => {
		const length = s.draw(element([0, 1, 31, 32, 33, 63, 64, 65]))
		const marked = s.draw(int(0, Math.min(2, length)))
		const first = marked >= 1 ? s.draw(int(0, length - marked)) : 0
		const marks =
			marked === 0 ? [] : marked === 1 ? [first] : [first, s.draw(int(first + 1, length - 1))]
		return { length, marks, dense: s.draw(boolean) }
	}

	/**
	 * Reading PostgreSQL's text, writing it back, enumerating, counting and testing membership agree with the model
	 * wherever a word begins or ends. Oracle: the Set model.
	 */
	const read = ({ length, marks, dense }: Marked, c: Case<Edge>) =>
		Effect.sync(() => {
			const text = marked(length, marks, dense)
			agrees(fromText(text), modelOf(text))
			c.note(
				length === 0 ? "no bits" : length % wordBits === 0 ? "whole words" : "a partial last word"
			)
			if (!dense && Arr.some(marks, (k) => k % wordBits === wordBits - 1)) {
				c.note("a bit at a word's last position")
			}
			if (dense && length > 0) {
				c.note("a dense string")
			}
		})

	it.effect(
		"read, enumerate, count and test every position as the model does, at every word edge",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/codec/bits-edges",
						generator: edges,
						literal: Formatter.format,
						limit: 15_670,
						coverage: requiredInSpace<Edge>([
							"no bits",
							"a partial last word",
							"whole words",
							"a bit at a word's last position",
							"a dense string"
						]),
						caseHang
					},
					read
				)
			)
	)

	type Block = "one one" | "one zero" | "past one block" | "past two blocks"

	/**
	 * Every string with exactly one one, and every string with exactly one zero, at each length beside a Harley–Seal
	 * block's edges (255 to 257, 511 to 513 and 543 to 545 positions, blocks of eight words), 7,872 strings: the count
	 * carries through every counter plane.
	 */
	const blocks: Gen<Marked> = (s) => {
		const length = s.draw(element([255, 256, 257, 511, 512, 513, 543, 544, 545]))
		return { length, marks: [s.draw(int(0, length - 1))], dense: s.draw(boolean) }
	}

	/** The Harley–Seal count and the enumeration agree with the model's count at every block edge. Oracle: the Set model. */
	const counted = ({ length, marks, dense }: Marked, c: Case<Block>) =>
		Effect.sync(() => {
			const text = marked(length, marks, dense)
			const model = modelOf(text)
			const bits = fromText(text)
			assert.equal(count(bits), model.ones.size)
			assert.deepEqual(members(bits), ascending(model.ones))
			c.note(dense ? "one zero" : "one one")
			c.note(length > 16 * wordBits ? "past two blocks" : "past one block")
		})

	it.effect("count and enumerate every block edge as the model does", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/codec/bits-blocks",
					generator: blocks,
					literal: Formatter.format,
					limit: 7872,
					coverage: requiredInSpace<Block>([
						"one one",
						"one zero",
						"past one block",
						"past two blocks"
					]),
					caseHang
				},
				counted
			)
		)
	)
})

/** How densely a drawn string's positions hold a 1: counts and enumerations differ most at none and at every one. */
type Density = "none" | "every" | "sparse" | "half" | "dense"

const densities: Gen<Density> = element<Density>(["none", "every", "sparse", "half", "dense"])

const bitAt: { readonly [D in Density]: Gen<string> } = {
	none: constant("0"),
	every: constant("1"),
	sparse: weighted([
		[1, constant("1")],
		[15, constant("0")]
	]),
	half: element(["0", "1"]),
	dense: weighted([
		[15, constant("1")],
		[1, constant("0")]
	])
}

/**
 * Lengths at and beside the boundaries where a word or a Harley–Seal block of eight words starts or ends, or any up to
 * four blocks and a word.
 */
const lengths: Gen<number> = oneOf([
	element([0, 1, 31, 32, 33, 63, 64, 65, 255, 256, 257, 511, 512, 513, 543, 544, 545]),
	int(0, 1056)
])

/** The text of a string of `length` positions, each drawn at `density`. */
const textAt = (length: number, density: Density): Gen<string> =>
	string(bitAt[density], { min: length, max: length })

/** The text of a string of a drawn length and density. */
const texts: Gen<string> = (source) =>
	source.draw(textAt(source.draw(lengths), source.draw(densities)))

/** The planes of a fold of `folded`, strings of `length` bits each, stepped in their order from nothing. */
const foldOf = (length: number, folded: ReadonlyArray<string>): Planes => {
	const fold = planes(length)
	for (const text of folded) {
		step(fold, fromText(text))
	}
	return fold
}

describe("bit strings on the host", () => {
	type Read =
		| "no bits"
		| "a partial last word"
		| "whole words"
		| "past two blocks"
		| "every bit"
		| "some bits"

	/** Any density at any length up to four blocks and a word agrees with the model throughout. Oracle: the Set model. */
	const readAny = (text: string, c: Case<Read>) =>
		Effect.sync(() => {
			const model = modelOf(text)
			c.note(
				model.length === 0
					? "no bits"
					: model.length % wordBits === 0
						? "whole words"
						: "a partial last word"
			)
			if (model.length > 16 * wordBits) {
				c.pair("past two blocks", model.ones.size === model.length ? "every bit" : "some bits")
			}
			agrees(fromText(text), model)
		})

	it.effect(
		"read PostgreSQL's text as the model's positions, total past either end, and write the same text back",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/codec/bits-read",
						draw: drawn(texts),
						literal: Formatter.format,
						coverage: required<Read>(
							[
								"no bits",
								"a partial last word",
								"whole words",
								["past two blocks", "every bit"],
								["past two blocks", "some bits"]
							],
							{ cases: 500, sense: notesOnly }
						),
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					readAny
				)
			)
	)

	type Added = "new" | "already there" | "outside" | "from nothing"

	interface Additions {
		readonly text: string
		readonly fresh: boolean
		readonly positions: ReadonlyArray<number>
	}

	/**
	 * The branchless set-and-count: each add returns 1 for a new bit and 0 for one already there, so a fold's count is
	 * the sum of what its adds return; and a position outside the string is a defect. Oracle: the Set model.
	 */
	const setAndCount = ({ text, fresh, positions }: Additions, c: Case<Added>) =>
		Effect.sync(() => {
			const bits = fresh ? empty(text.length) : fromText(text)
			const ones = new Set<number>(fresh ? [] : modelOf(text).ones)
			const before = ones.size
			let added = 0
			for (const k of positions) {
				if (k >= 0 && k < text.length) {
					c.note(ones.has(k) ? "already there" : "new")
					if (fresh && ones.has(k)) {
						c.pair("from nothing", "already there")
					}
					const one = add(bits, k)
					assert.equal(one, ones.has(k) ? 0 : 1, `position ${k}`)
					added += one
					ones.add(k)
				} else {
					c.note("outside")
					throwsDefect(() => add(bits, k), `position ${k}`)
				}
			}
			assert.equal(toText(bits), textOf({ length: text.length, ones }))
			assert.equal(count(bits), ones.size)
			assert.equal(before + added, ones.size)
		})

	it.effect(
		"add each bit in place, returning 1 for a new one and 0 for one already there, so their sum keeps the count, and refuse a position outside",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/codec/bits-add",
						draw: drawn((source): Additions => {
							const text = source.draw(texts)
							return {
								text,
								fresh: source.draw(boolean),
								positions: source.draw(array(int(-2, text.length + 1), { min: 0, max: 24 }))
							}
						}),
						literal: Formatter.format,
						coverage: required<Added>(
							["new", "already there", "outside", ["from nothing", "already there"]],
							{
								cases: 500,
								sense: notesOnly
							}
						),
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					setAndCount
				)
			)
	)

	type Combination = "or" | "and" | "andNot"
	type Combined = Combination | "lengths differ"

	const combinations: {
		readonly [C in Combination]: readonly [
			host: (target: BitString, source: BitString) => void,
			model: (target: ReadonlySet<number>, source: ReadonlySet<number>) => ReadonlySet<number>
		]
	} = {
		or: [or, (target, source) => target.union(source)],
		and: [and, (target, source) => target.intersection(source)],
		andNot: [andNot, (target, source) => target.difference(source)]
	}

	interface Combining {
		readonly combination: Combination
		readonly target: string
		readonly operand: string
	}

	/**
	 * or, and and andNot change their first string into the model's union, intersection and difference, and leave their
	 * second as it was; strings of two lengths are a defect, the first left as it was. Oracle: the Set model's algebra.
	 */
	const algebra = ({ combination, target, operand }: Combining, c: Case<Combined>) =>
		Effect.sync(() => {
			const [host, model] = combinations[combination]
			const bits = fromText(target)
			const by = fromText(operand)
			if (target.length === operand.length) {
				c.note(combination)
				host(bits, by)
				const ones = model(modelOf(target).ones, modelOf(operand).ones)
				assert.equal(toText(bits), textOf({ length: target.length, ones }))
				assert.equal(count(bits), ones.size)
			} else {
				c.note("lengths differ")
				throwsDefect(() => host(bits, by))
				assert.equal(toText(bits), target)
			}
			assert.equal(toText(by), operand)
		})

	it.effect(
		"combine two strings of one length into the first as the model's union, intersection and difference, and refuse two lengths",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/codec/bits-combine",
						draw: drawn((source): Combining => {
							const combination = source.draw(element<Combination>(["or", "and", "andNot"]))
							const length = source.draw(lengths)
							const other = source.draw(
								weighted([
									[9, constant(length)],
									[1, lengths]
								])
							)
							return {
								combination,
								target: source.draw(textAt(length, source.draw(densities))),
								operand: source.draw(textAt(other, source.draw(densities)))
							}
						}),
						literal: Formatter.format,
						coverage: required<Combined>(["or", "and", "andNot", "lengths differ"], {
							cases: 500,
							sense: notesOnly
						}),
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					algebra
				)
			)
	)

	type Folded = "a position twice" | "no position twice" | "lengths differ"

	interface Folding {
		readonly length: number
		readonly folded: ReadonlyArray<string>
		readonly stray: Option.Option<string>
	}

	/**
	 * A fold's planes are the positions set in at least one string and in at least two, whatever the strings; a string of
	 * another length is a defect. Oracle: the Set model's union and its union of pairwise intersections.
	 */
	const twoPlanes = ({ length, folded, stray }: Folding, c: Case<Folded>) =>
		Effect.sync(() => {
			const fold = foldOf(length, folded)
			if (Option.isSome(stray) && stray.value.length !== length) {
				c.note("lengths differ")
				throwsDefect(() => step(fold, fromText(stray.value)))
			}
			const sets = Arr.map(folded, (text) => modelOf(text).ones)
			const twos = unionOf(
				Arr.flatMap(sets, (set, i) =>
					Arr.map(sets.slice(i + 1), (later) => set.intersection(later))
				)
			)
			if (sets.length >= 2) {
				c.note(twos.size === 0 ? "no position twice" : "a position twice")
			}
			assert.equal(toText(fold.ones), textOf({ length, ones: unionOf(sets) }))
			assert.equal(toText(fold.twos), textOf({ length, ones: twos }))
		})

	it.effect(
		"fold strings into two planes, the positions set in at least one and the positions set in at least two",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/codec/bits-fold",
						draw: drawn((source): Folding => {
							const length = source.draw(lengths)
							return {
								length,
								folded: source.draw(
									array((s) => s.draw(textAt(length, s.draw(densities))), { min: 0, max: 5 })
								),
								stray: source.draw(option(texts))
							}
						}),
						literal: Formatter.format,
						coverage: required<Folded>(
							["a position twice", "no position twice", "lengths differ"],
							{
								cases: 500,
								sense: notesOnly
							}
						),
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					twoPlanes
				)
			)
	)

	type AtMostOne =
		| "a member twice in K"
		| "every member of K at most once"
		| "a member outside K twice"
		| "no member"

	interface Members {
		readonly width: number
		readonly placed: ReadonlyArray<number>
		readonly members: ReadonlyArray<number>
		readonly k: ReadonlyArray<number>
	}

	/**
	 * Every fold of zero to four members over a roster of one to four codes, against every set K of its codes, the
	 * roster's codes placed at the start of one word, across the edge of the first two words, or across the edge of the
	 * second and third: 19,674 folds.
	 */
	const folds: Gen<Members> = (s) => {
		const codes = s.draw(int(1, 4))
		const [width, positions] = s.draw(
			element<readonly [number, ReadonlyArray<number>]>([
				[4, [0, 1, 2, 3]],
				[33, [31, 32, 0, 30]],
				[65, [63, 64, 31, 32]]
			])
		)
		const placed = positions.slice(0, codes)
		const members = Array.from({ length: s.draw(int(0, 4)) }, () => s.draw(int(0, codes - 1)))
		const k = Arr.filter(
			Array.from({ length: codes }, (_, code) => code),
			() => s.draw(boolean)
		)
		return { width, placed, members, k }
	}

	/**
	 * The saturating fold of members' one-hot strings, as qti-pie folds a node's children: "at most one of K" holds,
	 * `twos & K` empty, exactly when no code of K is a member twice; `ones & K` holds the members of K; and folding the
	 * members in reverse gives the same planes, as a commutative monoid must. Oracle: the members counted.
	 */
	const atMostOne = ({ width, placed, members: folded, k }: Members, c: Case<AtMostOne>) =>
		Effect.sync(() => {
			const oneHot = (code: number): BitString => {
				const bits = empty(width)
				add(bits, defined(placed[code]))
				return bits
			}
			const fold = planes(width)
			for (const code of folded) {
				step(fold, oneHot(code))
			}
			const backwards = planes(width)
			for (const code of Arr.reverse(folded)) {
				step(backwards, oneHot(code))
			}
			assert.equal(
				toText(backwards.ones),
				toText(fold.ones),
				"the order of the members never shows"
			)
			assert.equal(
				toText(backwards.twos),
				toText(fold.twos),
				"the order of the members never shows"
			)
			const mask = empty(width)
			for (const code of k) {
				add(mask, defined(placed[code]))
			}
			const times = (code: number): number => Arr.filter(folded, (member) => member === code).length
			const twosInK = fromText(toText(fold.twos))
			and(twosInK, mask)
			const onesInK = fromText(toText(fold.ones))
			and(onesInK, mask)
			const once = Arr.every(k, (code) => times(code) <= 1)
			assert.equal(count(twosInK) === 0, once, "at most one of K")
			assert.equal(count(onesInK), Arr.filter(k, (code) => times(code) >= 1).length)
			if (folded.length === 0) {
				c.note("no member")
			}
			c.note(once ? "every member of K at most once" : "a member twice in K")
			if (Arr.some(folded, (code) => !k.includes(code) && times(code) >= 2)) {
				c.note("a member outside K twice")
			}
		})

	it.effect(
		"fold members so that at most one of K is twos & K empty, in any order of the members",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/codec/bits-at-most-one",
						generator: folds,
						literal: Formatter.format,
						limit: 19_674,
						coverage: requiredInSpace<AtMostOne>([
							"a member twice in K",
							"every member of K at most once",
							"a member outside K twice",
							"no member"
						]),
						caseHang
					},
					atMostOne
				)
			)
	)

	type CellRead =
		| "inside one word"
		| "across two words"
		| "before the start"
		| "past the end"
		| "a negative int4"

	/**
	 * PostgreSQL's `substring(S FROM from FOR span)` of a bit string's text: the positions from `from`, 1-based, for
	 * `span`, cut to those inside S, so empty past either end.
	 */
	const substring = (text: string, from: number, span: number): string =>
		Str.slice(Math.max(from - 1, 0), Math.max(from - 1 + span, 0))(text)

	/** PostgreSQL's cast of a bit string to int4: one binary numeral, its 32 bits read signed, and 0 when empty. */
	const int4 = (text: string): number => (text === "" ? 0 : Number.parseInt(text, 2) | 0)

	/** One cell read against the model, its situation noted. */
	const readsAs = (
		bits: BitString,
		text: string,
		index: number,
		width: number,
		c: Case<CellRead>
	): void => {
		const at = index * width
		if (at < 0) {
			c.note("before the start")
		} else if (at >= text.length) {
			c.note("past the end")
		} else {
			c.note(
				Math.floor(at / wordBits) === Math.floor((at + width - 1) / wordBits)
					? "inside one word"
					: "across two words"
			)
		}
		const expected = int4(substring(text, at + 1, width))
		if (expected < 0) {
			c.note("a negative int4")
		}
		assert.equal(cell(bits, index, width), expected, `cell ${index} of ${width} bits`)
	}

	/** The one-hot strings of three words, a 1 at each of positions 0 to 95, and the string of none: 97. */
	const oneHots: Gen<Option.Option<number>> = (s) =>
		s.draw(boolean) ? Option.some(s.draw(int(0, 3 * wordBits - 1))) : Option.none()

	/**
	 * A cell's read places each bit of the string where PostgreSQL's substring and int4 cast place it: on every one-hot
	 * string of three words, at every width from 1 to 32, the string's length rounded up to whole cells of that width
	 * (the contract's strings: a constant is exactly its cells times w bits), and every index from before the start to
	 * past the end. A read copies each bit of its window to one place, so the one-hot strings determine it on every
	 * string. Oracle: PostgreSQL's substring and int4 restated on the text.
	 */
	const placement = (hot: Option.Option<number>, c: Case<CellRead>) =>
		Effect.sync(() => {
			for (let width = 1; width <= wordBits; width++) {
				const length = Math.ceil((3 * wordBits) / width) * width
				const text = marked(length, Option.isSome(hot) ? [hot.value] : [], false)
				const bits = fromText(text)
				for (let index = -2; index * width < length + 2 * width; index++) {
					readsAs(bits, text, index, width, c)
				}
			}
		})

	it.effect(
		"read a w-bit cell of every one-hot string as PostgreSQL casts its substring to int4",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/codec/bits-cell-placement",
						generator: oneHots,
						literal: Formatter.format,
						limit: 97,
						coverage: requiredInSpace<CellRead>([
							"inside one word",
							"across two words",
							"before the start",
							"past the end",
							"a negative int4"
						]),
						caseHang
					},
					placement
				)
			)
	)

	interface Cells {
		readonly width: number
		readonly text: string
		readonly indices: ReadonlyArray<number>
	}

	/** Any density's cells read as PostgreSQL reads them, 0 past either end. Oracle: PostgreSQL's substring and int4 cast. */
	const anyCells = ({ width, text, indices }: Cells, c: Case<CellRead>) =>
		Effect.sync(() => {
			const bits = fromText(text)
			for (const index of indices) {
				readsAs(bits, text, index, width, c)
			}
		})

	it.effect(
		"read a w-bit cell as PostgreSQL casts its substring to int4, and 0 past either end",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/codec/bits-cell",
						draw: drawn((source): Cells => {
							const width = source.draw(oneOf([element([1, 2, 5, 8, 31, 32]), int(1, 32)]))
							const cells = source.draw(int(0, 40))
							return {
								width,
								text: source.draw(textAt(cells * width, source.draw(densities))),
								indices: source.draw(array(int(-3, cells + 2), { min: 1, max: 12 }))
							}
						}),
						literal: Formatter.format,
						coverage: required<CellRead>(
							[
								"inside one word",
								"across two words",
								"before the start",
								"past the end",
								"a negative int4"
							],
							{ cases: 1000, sense: notesOnly }
						),
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					anyCells
				)
			)
	)
})
