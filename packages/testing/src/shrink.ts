import { Array as Arr, Effect, Option } from "effect"
import type { Gen } from "#gen.ts"
import { type Generated, forcedChooser, generate } from "#source.ts"
import { digestOf, shortlex, type Tape } from "#tape.ts"

/**
 * How much shrinking may cost, counted in candidates run, never in wall time, so the same failure shrinks to the
 * same case on every machine.
 */
export type ShrinkBudget =
	| Readonly<{ kind: "complete" }>
	| Readonly<{ kind: "bounded"; candidates: number }>

/** Shrink until no pass makes progress. */
export const completeShrink: ShrinkBudget = { kind: "complete" }

/** Shrink at most `candidates` candidates. */
export const boundedShrink = (candidates: number): ShrinkBudget => ({ kind: "bounded", candidates })

/** A failing case: the tape it drew, and what the caller reports of its failure. */
export type Failing<X> = Readonly<{ tape: Tape; failure: X }>

/**
 * One run of a candidate, with the tape it really drew: it still fails, with what the caller reports of the failure,
 * or it holds. A candidate that gave itself up never ran its property, so it holds. A candidate is cut when its
 * caller's deadline arrived before it ended, so shrinking ends there with the smallest failing case so far.
 */
export type Attempt<X> =
	| Readonly<{ kind: "fails"; tape: Tape; failure: X }>
	| Readonly<{ kind: "holds"; tape: Tape }>
	| Readonly<{ kind: "cut" }>

/** Why shrinking ended: no pass made progress, its budget of candidates ran out, or its caller's deadline arrived. */
export type ShrinkEnd = "minimal" | "budget" | "deadline"

/** The smallest failing case shrinking reached, how many candidates it ran to their end, and why it ended. */
export type Shrunk<X> = Readonly<{ best: Failing<X>; candidates: number; ended: ShrinkEnd }>

/** Values with the decisions `[start, end)` removed. */
const without = (values: Float64Array, start: number, end: number) => {
	const kept = new Float64Array(values.length - (end - start))
	kept.set(values.subarray(0, start))
	kept.set(values.subarray(end), start)
	return kept
}

/** Values with the value at `at` replaced. */
const replaced = (values: Float64Array, at: number, value: number) => {
	const copy = values.slice()
	copy[at] = value
	return copy
}

/** Values with the decisions `[start, end)` at their simplest. */
const simplified = (tape: Tape, start: number, end: number) => {
	const copy = tape.values.slice()
	copy.set(tape.lo.subarray(start, end), start)
	return copy
}

/** The `element` span that follows an `element` span in the same collection: the next one at its depth that starts
 * where it ends. */
const nextItemOf = (tape: Tape, element: number): Option.Option<number> => {
	const depth = tape.spanDepth[element] ?? 0
	const end = tape.spanEnd[element] ?? 0
	for (let span = element + 1; span < tape.spanLabel.length; span += 1) {
		const spanDepth = tape.spanDepth[span] ?? 0
		if (spanDepth < depth) {
			return Option.none()
		}
		if (spanDepth === depth && tape.spanLabel[span] === "element") {
			return (tape.spanStart[span] ?? 0) === end ? Option.some(span) : Option.none()
		}
	}
	return Option.none()
}

/**
 * One collection of a tape: the tape's decisions, the decisions `[start, bounds[0])` that count its items, and its
 * items, item `i` the decisions `[bounds[i], bounds[i + 1])`. Its items are `element` spans at one depth, each starting
 * where the one before it ends with no shallower span between them. The `array` span that holds them counts them by its
 * decisions before its first item: its length, or none when its size admits one length; a run of items no `array` span
 * holds has no count. Its bounds never decrease and end within the decisions it carries, so deleting or exchanging its
 * items is an edit of those decisions alone.
 */
type Collection = Readonly<{ values: Float64Array; start: number; bounds: ReadonlyArray<number> }>

/** One item of a tape: the collection it is an item of, and which of its items it is. */
type Item = Readonly<{ collection: Collection; at: number }>

/**
 * Where the decisions that count a collection begin: at the start of the span its first item is directly inside, the
 * nearest one before it a level out, when that span is an `array`, and otherwise at its first item, counting nothing.
 */
const countStartOf = (tape: Tape, first: number): number => {
	const depth = (tape.spanDepth[first] ?? 0) - 1
	for (let span = first - 1; span >= 0; span -= 1) {
		if ((tape.spanDepth[span] ?? 0) === depth) {
			return tape.spanLabel[span] === "array"
				? (tape.spanStart[span] ?? 0)
				: (tape.spanStart[first] ?? 0)
		}
	}
	return tape.spanStart[first] ?? 0
}

/**
 * Every `element` span of a tape as an item of its collection, in the order the spans opened. A collection begins at an
 * `element` span no earlier one is followed by, and holds every item that follows it.
 */
const itemsOf = (tape: Tape): ReadonlyArray<Item> => {
	const found = new Map<number, Item>()
	for (let span = 0; span < tape.spanLabel.length; span += 1) {
		if (tape.spanLabel[span] !== "element" || found.has(span)) {
			continue
		}
		const members = [span]
		for (
			let next = nextItemOf(tape, span);
			Option.isSome(next);
			next = nextItemOf(tape, next.value)
		) {
			members.push(next.value)
		}
		const collection: Collection = {
			values: tape.values,
			start: countStartOf(tape, span),
			bounds: [
				tape.spanStart[span] ?? 0,
				...Arr.map(members, (member) => tape.spanEnd[member] ?? 0)
			]
		}
		for (const [at, member] of members.entries()) {
			found.set(member, { collection, at })
		}
	}
	return Arr.getSomes(
		Arr.map(Arr.fromIterable(tape.spanLabel.keys()), (span) =>
			Option.fromUndefinedOr(found.get(span))
		)
	)
}

/** An item's collection's decisions with the item removed and every decision that counts its items one lower. */
const withoutItem = ({ collection, at }: Item) => {
	const { values, start, bounds } = collection
	const shorter = without(values, bounds[at] ?? 0, bounds[at + 1] ?? 0)
	for (let count = start; count < (bounds[0] ?? 0); count += 1) {
		shorter[count] = (shorter[count] ?? 0) - 1
	}
	return shorter
}

/**
 * An item's collection's decisions with the item and the one `later` items after it exchanged, the items between them
 * kept, while that later item is one of its collection's.
 */
const exchanged = ({ collection, at }: Item, later: number): Option.Option<Float64Array> =>
	Option.map(Arr.get(collection.bounds, at + later + 1), (end) => {
		const { values, bounds } = collection
		const start = bounds[at] ?? 0
		const firstEnd = bounds[at + 1] ?? 0
		const second = bounds[at + later] ?? 0
		const copy = values.slice()
		copy.set(values.subarray(second, end), start)
		copy.set(values.subarray(firstEnd, second), start + end - second)
		copy.set(values.subarray(start, firstEnd), end - (firstEnd - start))
		return copy
	})

/**
 * A failing case with its tape's items, parsed when it becomes the best, so a pass reads the items of the tape it
 * edits.
 */
type Parsed<X> = Failing<X> & Readonly<{ items: ReadonlyArray<Item> }>

const parsedOf = <X>(failing: Failing<X>): Parsed<X> => ({
	...failing,
	items: itemsOf(failing.tape)
})

/**
 * Shrinks a failing attempt by editing its tape. Every pass proposes smaller values; `attempt` runs them and reports
 * the tape it really drew, which counts only when it is strictly smaller in shortlex order and still fails, so
 * shrinking always ends and only ever moves toward simpler cases. A cut attempt ends shrinking at once, with the
 * smallest failing case so far. The best case carries its tape's items, parsed when it becomes the best, and every
 * candidate of an item is built from its own collection's decisions. The passes, in order of how much each removes:
 * - delete one item of a collection (its decisions, and one off each decision that counts the collection);
 * - delete any span outright;
 * - set every decision of a span to its simplest;
 * - swap two items of a collection, so a sequence whose failure needs its items in some order reaches the simplest
 *   order, which deleting and lowering alone cannot reorder into;
 * - lower each decision by binary search toward its simplest.
 * Once its budget is spent or its deadline has arrived, no pass builds another candidate. The candidates already tried
 * are remembered for this shrink alone, and forgotten when it ends: a digest finds them, and their values are compared
 * before one is skipped, so a collision never passes over a distinct candidate. Every candidate is smaller than the
 * best, so each accepted shrink forgets those it is not smaller than: none of them could be proposed again.
 */
export const shrinkAttempt = <X, R>(
	failing: Failing<X>,
	attempt: (values: Float64Array) => Effect.Effect<Attempt<X>, never, R>,
	budget: ShrinkBudget
): Effect.Effect<Shrunk<X>, never, R> =>
	Effect.gen(function* () {
		let best = parsedOf(failing)
		let candidates = 0
		let deadlineArrived = false
		const tried = new Map<number, Array<Float64Array>>()
		const triedBefore = (digest: number, values: Float64Array) =>
			Arr.some(
				tried.get(digest) ?? [],
				(seen) => shortlex(seen, seen.length, values, values.length) === 0
			)
		const budgetSpent = () => budget.kind === "bounded" && candidates >= budget.candidates
		const exhausted = () => deadlineArrived || budgetSpent()
		const endOf = (): ShrinkEnd => {
			if (deadlineArrived) {
				return "deadline"
			}
			return budgetSpent() ? "budget" : "minimal"
		}
		const belowBest = (values: Float64Array) =>
			shortlex(values, values.length, best.tape.values, best.tape.length) === -1
		const forgetAboveBest = () => {
			for (const [digest, seen] of tried) {
				const below = Arr.filter(seen, belowBest)
				if (Arr.isReadonlyArrayNonEmpty(below)) {
					tried.set(digest, below)
				} else {
					tried.delete(digest)
				}
			}
		}

		const propose = Effect.fnUntraced(function* (values: Float64Array) {
			if (exhausted()) {
				return false
			}
			const digest = digestOf(values, values.length)
			if (triedBefore(digest, values) || !belowBest(values)) {
				return false
			}
			tried.set(digest, [...(tried.get(digest) ?? []), values])
			const result = yield* attempt(values)
			if (result.kind === "cut") {
				deadlineArrived = true
				return false
			}
			candidates += 1
			switch (result.kind) {
				case "holds":
					return false
				case "fails":
					if (
						shortlex(result.tape.values, result.tape.length, best.tape.values, best.tape.length) !==
						-1
					) {
						return false
					}
					best = parsedOf({ tape: result.tape, failure: result.failure })
					forgetAboveBest()
					return true
			}
		})

		const deleteItems = Effect.fnUntraced(function* () {
			let progressed = false
			for (
				let cursor = best.items.length - 1;
				cursor >= 0 && !exhausted();
				cursor = Math.min(cursor, best.items.length) - 1
			) {
				progressed = (yield* propose(withoutItem(Arr.getUnsafe(best.items, cursor)))) || progressed
			}
			return progressed
		})

		const deleteSpans = Effect.fnUntraced(function* () {
			let progressed = false
			for (let span = best.tape.spanLabel.length - 1; span >= 0 && !exhausted(); span -= 1) {
				const start = best.tape.spanStart[span] ?? 0
				const end = best.tape.spanEnd[span] ?? 0
				if (end > start) {
					progressed = (yield* propose(without(best.tape.values, start, end))) || progressed
				}
			}
			return progressed
		})

		const simplifySpans = Effect.fnUntraced(function* () {
			let progressed = false
			for (let span = best.tape.spanLabel.length - 1; span >= 0 && !exhausted(); span -= 1) {
				const start = best.tape.spanStart[span] ?? 0
				const end = best.tape.spanEnd[span] ?? 0
				if (end > start) {
					progressed = (yield* propose(simplified(best.tape, start, end))) || progressed
				}
			}
			return progressed
		})

		const exchangeAt = (cursor: number, later: number) =>
			Option.flatMap(Arr.get(best.items, cursor), (item) => exchanged(item, later))

		const reorderItems = Effect.fnUntraced(function* () {
			let progressed = false
			for (let cursor = 0; cursor < best.items.length && !exhausted(); cursor += 1) {
				let later = 1
				let exchange = exchangeAt(cursor, later)
				while (Option.isSome(exchange) && !exhausted()) {
					progressed = (yield* propose(exchange.value)) || progressed
					later += 1
					exchange = exchangeAt(cursor, later)
				}
			}
			return progressed
		})

		const lowerChoices = Effect.fnUntraced(function* () {
			let progressed = false
			for (let at = 0; at < best.tape.length && !exhausted(); at += 1) {
				const lo = best.tape.lo[at] ?? 0
				const value = best.tape.values[at] ?? 0
				if (value === lo) {
					continue
				}
				if (yield* propose(replaced(best.tape.values, at, lo))) {
					progressed = true
					continue
				}
				let low = lo
				let high = value
				while (low + 1 < high && !exhausted()) {
					const middle = low + Math.floor((high - low) / 2)
					if (yield* propose(replaced(best.tape.values, at, middle))) {
						high = middle
						progressed = true
					} else {
						low = middle
					}
				}
			}
			return progressed
		})

		let progressed = true
		while (progressed && !exhausted()) {
			const deleted = yield* deleteItems()
			const dropped = yield* deleteSpans()
			const simplifiedAny = yield* simplifySpans()
			const reordered = yield* reorderItems()
			const lowered = yield* lowerChoices()
			progressed = deleted || dropped || simplifiedAny || reordered || lowered
		}
		return { best: { tape: best.tape, failure: best.failure }, candidates, ended: endOf() }
	})

/** Shrinks a failing case of a plain generator against a predicate that says whether a value still fails. */
export const shrink = <A, R>(
	generator: Gen<A>,
	failing: Generated<A>,
	stillFails: (value: A) => Effect.Effect<boolean, never, R>,
	budget: ShrinkBudget
): Effect.Effect<Shrunk<A>, never, R> =>
	shrinkAttempt(
		{ tape: failing.tape, failure: failing.value },
		(values): Effect.Effect<Attempt<A>, never, R> => {
			const candidate = generate(generator, forcedChooser(values, values.length))
			return candidate.tape.status === "discarded"
				? Effect.succeed({ kind: "holds", tape: candidate.tape })
				: Effect.map(stillFails(candidate.value), (fails): Attempt<A> =>
						fails
							? { kind: "fails", tape: candidate.tape, failure: candidate.value }
							: { kind: "holds", tape: candidate.tape }
					)
		},
		budget
	)
