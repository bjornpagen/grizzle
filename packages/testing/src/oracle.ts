import { Array as Arr, Effect, Equal, Formatter, Hash, Option, Schema } from "effect"

/**
 * How two answers may differ and still agree: a difference in words, or none. A test asserts exactly what its contract
 * promises and nothing stronger, so an answer whose order the contract leaves open is compared as a set, never as a
 * list whose order happens to be stable today. No answer is a multiset: a repeated item is always a difference.
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

/**
 * The key of a set of items compared `exact`ly: Effect's structural hash, which Equal.equals keeps, so equal items have
 * one key, arrays, records, Options and class instances included.
 */
export const structuralHash = (item: unknown): number => Hash.hash(item)

/** Items grouped by their key, each group in the order its items come: what a set comparison compares within. */
const groupsOf = <A>(
	key: (item: A) => number,
	values: ReadonlyArray<A>
): ReadonlyMap<number, ReadonlyArray<A>> => {
	const groups = new Map<number, Array<A>>()
	for (const value of values) {
		const at = key(value)
		const group = groups.get(at)
		if (group === undefined) {
			groups.set(at, [value])
		} else {
			group.push(value)
		}
	}
	return groups
}

/** The first item of `values` a later item of its own group repeats, by `item`, if one does. */
const repeatOf = <A>(
	item: Equivalence<A>,
	values: ReadonlyArray<A>,
	groups: ReadonlyMap<number, ReadonlyArray<A>>,
	key: (item: A) => number
): Option.Option<A> =>
	Arr.findFirst(values, (value) => {
		const group = groups.get(key(value)) ?? []
		const at = group.indexOf(value)
		return Arr.some(Arr.drop(group, at + 1), (later) => Option.isNone(item(value, later)))
	})

/** Whether `value` has an equal, by `item`, in the group of `groups` its key names. */
const heldIn = <A>(
	item: Equivalence<A>,
	groups: ReadonlyMap<number, ReadonlyArray<A>>,
	key: (item: A) => number,
	value: A
): boolean => Arr.some(groups.get(key(value)) ?? [], (other) => Option.isNone(item(value, other)))

/**
 * The same items, in any order, each compared by `item`, where neither side holds an item twice: an answer that repeats
 * an item is not the set its contract names, so a repeat on either side is a difference, which names the repeated item,
 * and never folds away. It is the one unordered comparison: no answer is a multiset. `key` hashes an item consistently
 * with `item`, so items `item` finds equal have one key (structuralHash is that key for `exact`, and for a row
 * compared by its columns' own equality a hash of their canonical forms). Items are grouped by key and compared only
 * within their group, so a comparison takes time linear in the answers when keys spread, and a repeat or a difference
 * is found without comparing every pair.
 */
export const set =
	<A>(key: (item: NoInfer<A>) => number, item: Equivalence<A>): Equivalence<ReadonlyArray<A>> =>
	(left, right) => {
		const leftGroups = groupsOf(key, left)
		const rightGroups = groupsOf(key, right)
		const repeated = Arr.findFirst(
			[
				["left", left, leftGroups],
				["right", right, rightGroups]
			] as const,
			([, values, groups]) => Option.isSome(repeatOf(item, values, groups, key))
		)
		return Option.match(repeated, {
			onNone: () => {
				const onlyLeft = Arr.filter(left, (value) => !heldIn(item, rightGroups, key, value))
				const onlyRight = Arr.filter(
					right,
					(value) => !heldIn((one, other) => item(other, one), leftGroups, key, value)
				)
				return Arr.isReadonlyArrayEmpty(onlyLeft) && Arr.isReadonlyArrayEmpty(onlyRight)
					? Option.none()
					: Option.some(
							`only left: ${Formatter.format(onlyLeft)}; only right: ${Formatter.format(onlyRight)}`
						)
			},
			onSome: ([side, values, groups]) =>
				Option.map(
					repeatOf(item, values, groups, key),
					(value) =>
						`${side} holds ${Formatter.format(value)} more than once, and a set holds an item once`
				)
		})
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
