import { Array as Arr, Option, type Predicate } from "effect"
import type { Source } from "#source.ts"

/**
 * A generator: a pure, synchronous function of the decisions it draws. Purity is what lets one generator be searched
 * at random, enumerated exhaustively, replayed from a tape and shrunk by editing its tape: none of those could see
 * through an effect or a hidden cache. A struct, a tuple or a value that depends on an earlier one is a plain function
 * body that draws from the same source: `(s) => ({ id: s.draw(todoId), done: s.draw(boolean) })`.
 */
export type Gen<A> = (source: Source) => A

/** The value a generator produces. */
export type GenValue<G> = G extends Gen<infer A> ? A : never

/** How many items a collection may hold. Every collection states its bound: small inputs find most bugs, and an
 * unbounded generator cannot be enumerated. */
export type Size = Readonly<{ min: number; max: number }>

/**
 * The whole number of `lo..hi` a decision's offset stands for, ordered by distance from zero: the value nearest zero
 * first, then outward one step at a time, the positive side before the negative, and past the shorter side's end the
 * longer side's remaining values. The order is a bijection, so a uniform offset is a uniform value.
 */
const nearZero = (offset: number, lo: number, hi: number): number => {
	if (lo >= 0) {
		return lo + offset
	}
	if (hi <= 0) {
		return hi - offset
	}
	if (offset === 0) {
		return 0
	}
	const paired = Math.min(hi, -lo)
	if (offset <= 2 * paired) {
		const distance = Math.ceil(offset / 2)
		return offset % 2 === 1 ? distance : -distance
	}
	const distance = offset - paired
	return hi > -lo ? distance : -distance
}

const WORD_SPAN = 0x1_0000_0000

/**
 * A whole number between `lo` and `hi`, inclusive, shrinking toward the value nearest zero: zero when the range holds
 * it, otherwise the bound nearest zero. Enumeration yields values in the same order. A range of up to 2^32 values is
 * one decision; a wider one, up to `Number.MAX_SAFE_INTEGER` wide, is two, the high word first and the low one bounded
 * so the whole never passes `hi`. A whole number wider still is a `bigint`.
 */
export const int = (lo: number, hi: number): Gen<number> => {
	const span = hi - lo
	if (span < WORD_SPAN) {
		return (source) => nearZero(source.choose(0, span), lo, hi)
	}
	const highest = Math.floor(span / WORD_SPAN)
	const lowestAtTop = span % WORD_SPAN
	return (source) => {
		const high = source.choose(0, highest)
		const low = source.choose(0, high === highest ? lowestAtTop : WORD_SPAN - 1)
		return nearZero(high * WORD_SPAN + low, lo, hi)
	}
}

/** `false` or `true`, shrinking toward `false`. */
export const boolean: Gen<boolean> = (source) => source.choose(0, 1) === 1

/** Always `value`, drawing nothing. */
export const constant =
	<A>(value: A): Gen<A> =>
	() =>
		value

/** One of `values`, shrinking toward the first: list the simplest first. */
export const element =
	<const A>(values: ReadonlyArray<A> & Readonly<{ 0: A }>): Gen<A> =>
	(source) =>
		Arr.getUnsafe(values, source.pick(0, values.length - 1))

/** A generator's values, transformed. */
export const map =
	<A, B>(generator: Gen<A>, transform: (value: A) => B): Gen<B> =>
	(source) =>
		transform(generator(source))

/** Labels a generator's decisions, so shrinking and mutation see them as one unit. */
export const span =
	<A>(label: string, generator: Gen<A>): Gen<A> =>
	(source) =>
		source.span(label, () => generator(source))

/** The whole numbers below `N`, built by a tail-recursive count, so a weight is a literal the type admits. */
type Below<N extends number, Counted extends Array<number> = []> = Counted["length"] extends N
	? Counted[number]
	: Below<N, [...Counted, Counted["length"]]>

/**
 * How often an option is drawn: a whole number from 1 to 99. Zero is not a weight, so a choice whose weights are all
 * zero cannot be written; a choice whose options switch off case by case is a swarm choice, which names its floor.
 */
export type Weight = Exclude<Below<100>, 0>

/** One option and how often it is drawn. */
export type Weighted<A> = readonly [weight: Weight, generator: Gen<A>]

/** The option a pick below the arms' total weight selects: each arm owns the next `weight` picks, and the last arm
 * owns the picks after every earlier arm's. */
const armOf = <A>(arms: Arr.NonEmptyReadonlyArray<Weighted<A>>, pick: number): Gen<A> => {
	let rest = pick
	for (let at = 0; at < arms.length - 1; at += 1) {
		const [weight, generator] = Arr.getUnsafe(arms, at)
		if (rest < weight) {
			return generator
		}
		rest -= weight
	}
	return Arr.lastNonEmpty(arms)[1]
}

/**
 * One of several generators, drawn in proportion to their weights, and shrinking toward the first. The draw is uniform
 * over the total weight, so no option is favoured by its position or by an encoding. Every weight is at least one, so
 * the total never is zero.
 */
export const weighted = <A>(options: Arr.NonEmptyReadonlyArray<Weighted<A>>): Gen<A> => {
	const total = Arr.reduce(options, 0, (sum, [weight]) => sum + weight)
	return (source) => {
		source.open("weighted")
		const value = armOf(options, source.pick(0, total - 1))(source)
		source.close()
		return value
	}
}

/**
 * One of several generators in proportion to weights computed when the generator is built (a share of a total, a count
 * a model holds), where `weighted` takes weights written in the source. A weight is a whole number, and zero for an
 * option that cannot be drawn there. An option alone in having weight is no choice and draws nothing; when every weight
 * is zero the first option, the floor, is drawn the same way, as a swarm choice draws its floor. The draw is uniform
 * over the total weight and shrinks toward the first option with weight.
 */
export const proportional =
	<A>(options: Arr.NonEmptyReadonlyArray<readonly [weight: number, generator: Gen<A>]>): Gen<A> =>
	(source) => {
		const live = Arr.filter(options, ([weight]) => Math.floor(weight) > 0)
		if (!Arr.isReadonlyArrayNonEmpty(live)) {
			return Arr.headNonEmpty(options)[1](source)
		}
		if (live.length === 1) {
			return Arr.headNonEmpty(live)[1](source)
		}
		const total = Arr.reduce(live, 0, (sum, [weight]) => sum + Math.floor(weight))
		source.open("weighted")
		let rest = source.pick(0, total - 1)
		let chosen = Arr.lastNonEmpty(live)[1]
		for (const [weight, generator] of live) {
			if (rest < Math.floor(weight)) {
				chosen = generator
				break
			}
			rest -= Math.floor(weight)
		}
		const value = chosen(source)
		source.close()
		return value
	}

/** One of several generators, equally often, shrinking toward the first. */
export const oneOf = <A>(generators: Arr.NonEmptyReadonlyArray<Gen<A>>): Gen<A> =>
	weighted(Arr.map(generators, (generator): Weighted<A> => [1, generator]))

/**
 * Between `size.min` and `size.max` items, the length chosen uniformly and first, then each item in its own span.
 * Shrinking deletes items by deleting their spans and lowering the length, and simplifies each item in place.
 */
export const array =
	<A>(item: Gen<A>, size: Size): Gen<ReadonlyArray<A>> =>
	(source) => {
		source.open("array")
		const length = source.choose(size.min, size.max)
		const items: Array<A> = []
		for (let index = 0; index < length; index += 1) {
			source.open("element")
			items.push(item(source))
			source.close()
		}
		source.close()
		return items
	}

/** One character whose code point lies between `lo` and `hi`, shrinking toward `lo`. */
export const codePoint = (lo: number, hi: number): Gen<string> =>
	map(int(lo, hi), (point) => String.fromCodePoint(point))

/** The first and last surrogate code points, which only pair into a character and are none on their own. */
const SURROGATES = { first: 0xd800, count: 0x800 } as const

/**
 * Any Unicode scalar value, every code point but a surrogate, shrinking toward U+0000: the characters well-formed text is
 * made of, where `codePoint(0, 0x10ffff)` would also draw a lone surrogate, which is no text at all.
 */
export const unicodeScalar: Gen<string> = map(int(0, 0x10_ffff - SURROGATES.count), (index) =>
	String.fromCodePoint(index < SURROGATES.first ? index : index + SURROGATES.count)
)

/** A string of between `size.min` and `size.max` characters from `character`. */
export const string = (character: Gen<string>, size: Size): Gen<string> =>
	map(array(character, size), Arr.join(""))

/** One character of `alphabet`, shrinking toward its first: build the alphabet from the literals the tests use. */
export const characterOf = (alphabet: Arr.NonEmptyReadonlyArray<string>): Gen<string> =>
	element(alphabet)

/** Some of `values`, in their order, each kept or left by its own decision, shrinking toward fewer. */
export const subarray =
	<A>(values: ReadonlyArray<A>): Gen<ReadonlyArray<A>> =>
	(source) => {
		source.open("subarray")
		const kept: Array<A> = []
		for (const value of values) {
			if (source.choose(0, 1) === 1) {
				kept.push(value)
			}
		}
		source.close()
		return kept
	}

/**
 * A value `keep` accepts, trying `attempts` draws. When none is kept the case is discarded and never runs. A filter
 * suits a predicate most values meet; a rare one belongs in the generator, which should build such values directly.
 */
export const filter =
	<A>(generator: Gen<A>, keep: Predicate.Predicate<A>, attempts: number): Gen<A> =>
	(source) => {
		let candidate = source.span("attempt", () => generator(source))
		for (let tried = 1; tried < attempts && !keep(candidate); tried += 1) {
			candidate = source.span("attempt", () => generator(source))
		}
		if (!keep(candidate)) {
			source.discard()
		}
		return candidate
	}

/**
 * A recursive structure at most `depth` levels deep: at each level the base case or one more step, the base case
 * first so shrinking flattens the structure. The bound keeps every value finite and every space enumerable.
 */
export const recursive = <A>(
	base: Gen<A>,
	step: (inner: Gen<A>) => Gen<A>,
	depth: number
): Gen<A> => (depth === 0 ? base : oneOf([base, step(recursive(base, step, depth - 1))]))

/** `Option.none()` one draw in six, otherwise a value of `generator`, shrinking toward none. */
export const option = <A>(generator: Gen<A>): Gen<Option.Option<A>> =>
	weighted([
		[1, constant(Option.none())],
		[5, map(generator, Option.some)]
	])

/**
 * Production's constant five draws in six, otherwise one of `small`, shrinking toward the constant. A threshold the
 * code under test takes as a parameter is drawn this way: the constant in force is what most cases meet and what a
 * failure shrinks to, and the small values put both sides of the threshold within a small case.
 */
export const production = <A>(inForce: A, small: Arr.NonEmptyReadonlyArray<A>): Gen<A> =>
	weighted([
		[5, constant(inForce)],
		[1, element(small)]
	])

/**
 * A non-empty subset of `letters`, drawn per case: one letter that every case has, then each other letter kept or
 * left by its own decision. Strings drawn from a few letters repeat them, which strings drawn from every letter almost
 * never do, and repetition is where code that compares, deduplicates or escapes text goes wrong. The kept letter comes
 * first, so characters drawn from the subset shrink toward it, and it shrinks toward the first of `letters`.
 */
export const alphabet =
	<A>(letters: Arr.NonEmptyReadonlyArray<A>): Gen<Arr.NonEmptyReadonlyArray<A>> =>
	(source) => {
		source.open("alphabet")
		const kept = source.pick(0, letters.length - 1)
		const others: Array<A> = []
		for (let index = 0; index < letters.length; index += 1) {
			if (index !== kept && source.choose(0, 1) === 1) {
				others.push(Arr.getUnsafe(letters, index))
			}
		}
		source.close()
		return [Arr.getUnsafe(letters, kept), ...others]
	}

/**
 * Between `size.min` and `size.max` of `values`, each at most once, in the order drawn: every item picks one of the
 * values not yet picked, so a draw of all of them is a permutation, and distinct values of a finite domain are drawn
 * by construction, never by retrying. It shrinks toward fewer items and toward the
 * values' own order. `size.max` is at most the number of values.
 */
export const shuffled =
	<A>(values: ReadonlyArray<A>, size: Size): Gen<ReadonlyArray<A>> =>
	(source) => {
		source.open("array")
		const length = source.choose(size.min, size.max)
		let rest = values
		const picked: Array<A> = []
		for (let index = 0; index < length; index += 1) {
			source.open("element")
			const at = source.pick(0, rest.length - 1)
			picked.push(Arr.getUnsafe(rest, at))
			rest = Arr.remove(rest, at)
			source.close()
		}
		source.close()
		return picked
	}

/**
 * Between `size.min` and `size.max` whole numbers of `lo..hi` in ascending order, built from the gaps between them, so
 * every draw is sorted by construction and no draw is filtered: the length first, then each gap, each as large as the
 * slack the gaps before it left, where `step` is the least each value exceeds the one before (1 strictly increasing, 0
 * repeating). Shrinking lowers the gaps toward none, toward the run that starts at `lo`.
 */
const ascending =
	(lo: number, hi: number, size: Size, step: 0 | 1): Gen<ReadonlyArray<number>> =>
	(source) => {
		source.open("array")
		const length = source.choose(size.min, size.max)
		const values: Array<number> = []
		let slack = hi - lo - step * Math.max(0, length - 1)
		let at = lo
		for (let index = 0; index < length; index += 1) {
			source.open("element")
			const gap = source.choose(0, slack)
			at += (index === 0 ? 0 : step) + gap
			slack -= gap
			values.push(at)
			source.close()
		}
		source.close()
		return values
	}

/**
 * Between `size.min` and `size.max` distinct whole numbers of `lo..hi`, strictly increasing: a sorted set drawn by its
 * gaps, never sorted or deduplicated after the fact. `size.max` is at most the range's width, `hi - lo + 1`.
 */
export const increasing = (lo: number, hi: number, size: Size): Gen<ReadonlyArray<number>> =>
	ascending(lo, hi, size, 1)

/** Between `size.min` and `size.max` whole numbers of `lo..hi`, in order and repeating as they may: a sorted list. */
export const nondecreasing = (lo: number, hi: number, size: Size): Gen<ReadonlyArray<number>> =>
	ascending(lo, hi, size, 0)

/**
 * Between `size.min` and `size.max` of `values`, each at most once and in their own order: a subset of a chosen size,
 * drawn as its strictly increasing positions, shrinking toward fewer values and toward the first ones. Where the
 * order of the drawn values matters, `shuffled` draws them in any order, each at most once.
 */
export const subset = <A>(values: ReadonlyArray<A>, size: Size): Gen<ReadonlyArray<A>> =>
	map(increasing(0, values.length - 1, size), (at) =>
		Arr.map(at, (index) => Arr.getUnsafe(values, index))
	)

/**
 * A rooted tree of between `size.min` and `size.max` nodes, numbered from the root, as the parent of every node after
 * the first: entry `i` is the parent of node `i + 1`, a node numbered below it, so every draw is a tree, acyclic and
 * connected by construction. A tree has its root, so `size.min` is at least 1. Shrinking moves every node toward the
 * root, toward a star.
 */
export const parents =
	(size: Size): Gen<ReadonlyArray<number>> =>
	(source) => {
		source.open("array")
		const nodes = source.choose(size.min, size.max)
		const parent: Array<number> = []
		for (let node = 1; node < nodes; node += 1) {
			source.open("element")
			parent.push(source.pick(0, node - 1))
			source.close()
		}
		source.close()
		return parent
	}

/**
 * `parts` whole numbers, none negative, that sum to `total`: how `total` items fall into `parts` places (members into
 * owners, rows into families), each count drawn from what the counts before it left and the last taking the rest, so
 * the sum holds by construction. Shrinking empties the first places toward the last.
 */
export const composition =
	(total: number, parts: number): Gen<ReadonlyArray<number>> =>
	(source) => {
		source.open("composition")
		const counts: Array<number> = []
		let rest = total
		for (let place = 1; place < parts; place += 1) {
			const count = source.choose(0, rest)
			counts.push(count)
			rest -= count
		}
		if (parts > 0) {
			counts.push(rest)
		}
		source.close()
		return counts
	}

/**
 * Between `size.min` and `size.max` items whose keys all differ, each item drawn up to `attempts` times until its key
 * is new, and the case discarded when one never is. `key` names what makes two items the same, and its value is
 * compared as a `Set` compares, so it is a string or a number.
 */
export const uniqueArray =
	<A, K extends string | number>(
		item: Gen<A>,
		key: (item: A) => K,
		size: Size,
		attempts: number
	): Gen<ReadonlyArray<A>> =>
	(source) => {
		source.open("array")
		const length = source.choose(size.min, size.max)
		const seen = new Set<K>()
		const items: Array<A> = []
		for (let index = 0; index < length; index += 1) {
			source.open("element")
			const value = filter(item, (candidate) => !seen.has(key(candidate)), attempts)(source)
			seen.add(key(value))
			items.push(value)
			source.close()
		}
		source.close()
		return items
	}

/** Between `size.min` and `size.max` bytes, shrinking toward fewer and toward zero. */
export const bytes = (size: Size): Gen<Uint8Array> =>
	map(array(int(0, 255), size), (values) => Uint8Array.from(values))

/**
 * `count` equal values made apart: `generator` runs once on the case's decisions, then again on the same decisions for
 * each twin, so the twins are equal by structure and share no object. A test of code that must not tell equal values
 * by identity, or must not let one mutate the other, takes twins.
 */
export const clone =
	<A>(generator: Gen<A>, count: number): Gen<ReadonlyArray<A>> =>
	(source) => {
		const taken: Array<number> = []
		const recorded: Source = {
			...source,
			choose: (lo, hi) => {
				const value = source.choose(lo, hi)
				taken.push(value)
				return value
			},
			pick: (lo, hi) => {
				const value = source.pick(lo, hi)
				taken.push(value)
				return value
			},
			draw: (inner) => inner(recorded)
		}
		const twins: Array<A> = [generator(recorded)]
		while (twins.length < count) {
			let at = 0
			const next = (lo: number) => {
				const value = taken[at] ?? lo
				at += 1
				return value
			}
			const replayed: Source = {
				...source,
				choose: next,
				pick: next,
				draw: (inner) => inner(replayed),
				span: (_label, run) => run(),
				open: () => undefined,
				close: () => undefined,
				observe: () => "as-recorded"
			}
			twins.push(generator(replayed))
		}
		return twins
	}
