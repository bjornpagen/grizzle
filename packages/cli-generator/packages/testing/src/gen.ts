import { Array as Arr, Option, type Predicate, Schema } from "effect"
import { enumerated, firstBranch, nextBranch } from "#enumerate.ts"
import { forcedChooser, type Generated, generate, recorder, type Source } from "#source.ts"
import type { Tape } from "#tape.ts"

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
		Arr.getUnsafe(values, source.choose(0, values.length - 1))

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
		const value = armOf(options, source.choose(0, total - 1))(source)
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
		let rest = source.choose(0, total - 1)
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
		const kept = source.choose(0, letters.length - 1)
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
 * values not yet picked, so a draw of all of them is a permutation. It shrinks toward fewer items and toward the
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
			const at = source.choose(0, rest.length - 1)
			picked.push(Arr.getUnsafe(rest, at))
			rest = Arr.remove(rest, at)
			source.close()
		}
		source.close()
		return picked
	}

/**
 * A generator's draw from `source`, and the decisions it made there that a tape records, in order: every choice of
 * more than one value, and every observation. Generated again on exactly these decisions (forcedChooser), it gives the
 * same value, so a draw can be moved to a neighbour by editing them, as shrinking edits a tape.
 */
const drawnWithDecisions = <A>(
	generator: Gen<A>,
	source: Source
): Readonly<{ value: A; decisions: Float64Array }> => {
	const taken: Array<number> = []
	const recorded: Source = {
		...source,
		choose: (lo, hi) => {
			const value = source.choose(lo, hi)
			if (lo < hi) {
				taken.push(value)
			}
			return value
		},
		observe: (decided) => {
			taken.push(decided)
			return source.observe(decided)
		},
		draw: (inner) => inner(recorded)
	}
	return { value: generator(recorded), decisions: Float64Array.from(taken) }
}

/** Whether two tapes made the same decisions. */
const sameDecisions = (a: Tape, b: Tape): boolean =>
	a.length === b.length && a.values.every((value, at) => value === b.values[at])

/**
 * The key nearest the one `decisions` draw that `taken` does not hold, or none when the key generator holds no other:
 * first each decision of the drawn key in order, stepped up from its value through as many of its other values as
 * `taken` holds keys, wrapping to its least (a decision the key reads one-to-one meets a new key among them), every
 * other decision kept; then every key of the generator in its enumeration order after `drawn`, wrapping once to the
 * first. Both walk the key generator's own space and nothing beside it, so the walk ends within that space, however
 * large an item built from a key may be. Every candidate is generated on one recorder's buffers.
 */
const nearestNew = <K>(
	key: Gen<K>,
	decisions: Float64Array,
	taken: ReadonlySet<K>
): Option.Option<K> => {
	const recorded = recorder()
	const drawn = generate(recorded, key, forcedChooser(decisions, decisions.length)).tape
	const isNew = (generated: Generated<K>): boolean =>
		generated.tape.status !== "discarded" && !taken.has(generated.value)
	for (let at = 0; at < drawn.length; at += 1) {
		const lo = drawn.lo[at] ?? 0
		const width = (drawn.hi[at] ?? 0) - lo + 1
		const from = (drawn.values[at] ?? 0) - lo
		for (let step = 1; step < width && step <= taken.size; step += 1) {
			const edited = drawn.values.slice(0, drawn.length)
			edited[at] = lo + ((from + step) % width)
			const neighbour = generate(recorded, key, forcedChooser(edited, edited.length))
			if (isNew(neighbour)) {
				return Option.some(neighbour.value)
			}
		}
	}
	let branch = nextBranch(drawn)
	let wrapped = false
	for (;;) {
		if (Option.isNone(branch)) {
			if (wrapped) {
				return Option.none()
			}
			wrapped = true
		}
		const step = enumerated(
			recorded,
			key,
			Option.getOrElse(branch, () => firstBranch)
		)
		if (wrapped && sameDecisions(step.generated.tape, drawn)) {
			return Option.none()
		}
		if (isNew(step.generated)) {
			return Option.some(step.generated.value)
		}
		branch = step.next
	}
}

/**
 * A unique array's key generator holds fewer distinct keys than the least length the array was asked for: a defect of
 * the caller's generator, never a case, with the keys it held and the length it needed.
 */
export class UniqueKeysExhausted extends Schema.TaggedError<
	UniqueKeysExhausted,
	{ readonly brand: unique symbol }
>()("UniqueKeysExhausted", { held: Schema.Int, needed: Schema.Int, message: Schema.String }) {}

/**
 * Between `size.min` and `size.max` items of distinct keys, distinct by construction: the length is drawn first, then
 * for each item a key from `key` and the item `itemOf` builds from it. A key an earlier item holds is moved to the
 * nearest key that is new (nearestNew), which walks the key generator's space alone, never an item's, so the walk ends
 * however large what `itemOf` draws beside the key. No case is discarded and no key drawn twice. A key that is new is a
 * plain draw of `key`; one that repeats is a deterministic function of its draw and the keys before it, so a case
 * replays and shrinks as its tape says, shrinking deleting items and simplifying each key and item in place. A key
 * generator whose distinct keys run out stops the array there, and one holding fewer than `size.min` of them is a
 * defect of the caller's generator, never a case. Keys are compared as a `Set` compares, so a key is a string or a
 * number.
 */
export const uniqueArray =
	<K extends string | number, A>(
		key: Gen<K>,
		itemOf: (key: K) => Gen<A>,
		size: Size
	): Gen<ReadonlyArray<A>> =>
	(source) => {
		source.open("array")
		const length = source.choose(size.min, size.max)
		const seen = new Set<K>()
		const items: Array<A> = []
		for (let index = 0; index < length; index += 1) {
			source.open("element")
			const drawn = drawnWithDecisions(key, source)
			const unique = seen.has(drawn.value)
				? nearestNew(key, drawn.decisions, seen)
				: Option.some(drawn.value)
			if (Option.isNone(unique)) {
				source.close()
				if (items.length < size.min) {
					throw UniqueKeysExhausted.make({
						held: items.length,
						needed: size.min,
						message: `uniqueArray: the key generator holds ${items.length} distinct keys, fewer than the ${size.min} the array needs`
					})
				}
				break
			}
			seen.add(unique.value)
			items.push(source.draw(itemOf(unique.value)))
			source.close()
		}
		source.close()
		return items
	}

/** Between `size.min` and `size.max` distinct values of `key`, each drawn as uniqueArray draws a key. */
export const uniqueKeys = <K extends string | number>(
	key: Gen<K>,
	size: Size
): Gen<ReadonlyArray<K>> => uniqueArray(key, constant, size)

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
			draw: (inner) => inner(recorded)
		}
		const twins: Array<A> = [generator(recorded)]
		while (twins.length < count) {
			let at = 0
			const replayed: Source = {
				...source,
				choose: (lo) => {
					const value = taken[at] ?? lo
					at += 1
					return value
				},
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
