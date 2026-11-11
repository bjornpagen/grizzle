import { Array as Arr, Effect, Equal, Formatter, Option, Schema } from "effect"

/**
 * How two answers may differ and still agree: a difference in words, or none. A test asserts exactly what its contract
 * promises and nothing stronger, so an answer whose order the contract leaves open is compared as a set or a multiset,
 * never as a list whose order happens to be stable today.
 */
export type Equivalence<O> = (left: O, right: O) => Option.Option<string>

/** The same value, by Effect's structural equality. */
export const exact: Equivalence<unknown> = (left, right) =>
	Equal.equals(left, right)
		? Option.none()
		: Option.some(`${Formatter.format(left)} is not ${Formatter.format(right)}`)

/** The same items in the same order, each compared by `item`. */
export const ordered =
	<A>(item: Equivalence<A>): Equivalence<ReadonlyArray<A>> =>
	(left, right) => {
		if (left.length !== right.length) {
			return Option.some(`${left.length} items are not ${right.length}`)
		}
		for (let at = 0; at < left.length; at += 1) {
			const difference = item(Arr.getUnsafe(left, at), Arr.getUnsafe(right, at))
			if (Option.isSome(difference)) {
				return Option.some(`at ${at}: ${difference.value}`)
			}
		}
		return Option.none()
	}

/** The same items as many times each, in any order, each compared by `item`. */
export const multiset =
	<A>(item: Equivalence<A>): Equivalence<ReadonlyArray<A>> =>
	(left, right) => {
		const unmatched: Array<A> = Arr.copy(right)
		const extra: Array<A> = []
		for (const value of left) {
			const found = Arr.findFirstIndex(unmatched, (candidate) =>
				Option.isNone(item(value, candidate))
			)
			if (Option.isSome(found)) {
				unmatched.splice(found.value, 1)
			} else {
				extra.push(value)
			}
		}
		return Arr.isReadonlyArrayEmpty(extra) && Arr.isReadonlyArrayEmpty(unmatched)
			? Option.none()
			: Option.some(
					`only left: ${Formatter.format(extra)}; only right: ${Formatter.format(unmatched)}`
				)
	}

/** The same distinct items, in any order and however often each appears, each compared by `item`. */
export const set =
	<A>(item: Equivalence<A>): Equivalence<ReadonlyArray<A>> =>
	(left, right) => {
		const distinct = (values: ReadonlyArray<A>) =>
			Arr.reduce(values, Arr.empty<A>(), (kept, value) =>
				Arr.some(kept, (other) => Option.isNone(item(value, other)))
					? kept
					: Arr.append(kept, value)
			)
		return multiset(item)(distinct(left), distinct(right))
	}

/**
 * Answers that agree when a domain's own equality says so, each described by `describe` when they do not: the
 * comparison for values structural equality cannot judge, such as class instances that hold private fields.
 */
export const equivalence =
	<O>(equals: (left: O, right: O) => boolean, describe: (answer: O) => string): Equivalence<O> =>
	(left, right) =>
		equals(left, right) ? Option.none() : Option.some(`${describe(left)} is not ${describe(right)}`)

/** Answers compared through what the contract promises about them: `key` projects that part, `inner` compares it. */
export const by =
	<O, K>(key: (answer: O) => K, inner: Equivalence<K>): Equivalence<O> =>
	(left, right) =>
		inner(key(left), key(right))

/** Two sides of an oracle disagreed: the second side's answer differs from the first's in the way `difference` says. */
export class Disagreement extends Schema.TaggedError<
	Disagreement,
	{ readonly brand: unique symbol }
>()("Disagreement", {
	first: Schema.String,
	second: Schema.String,
	difference: Schema.String,
	message: Schema.String
}) {}

/** One side of an oracle: its name, and its answer. */
export type Side<O> = readonly [name: string, answer: O]

/**
 * Checks that every side of an oracle agrees with the first: a second implementation, a model, a specification
 * written as a checker. A disagreement fails with both names and the difference, so the report says which side to
 * suspect, and the model, the code and the documentation are all suspects.
 */
export const agree = <O>(
	sides: Arr.NonEmptyReadonlyArray<Side<O>>,
	comparison: Equivalence<O>
): Effect.Effect<void, Disagreement> => {
	const [firstName, firstAnswer] = Arr.headNonEmpty(sides)
	for (const [name, answer] of Arr.tailNonEmpty(sides)) {
		const difference = comparison(firstAnswer, answer)
		if (Option.isSome(difference)) {
			return Effect.fail(
				Disagreement.make({
					first: firstName,
					second: name,
					difference: difference.value,
					message: `${name} disagrees with ${firstName}: ${difference.value}`
				})
			)
		}
	}
	return Effect.void
}
