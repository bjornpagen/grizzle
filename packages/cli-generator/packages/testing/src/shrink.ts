import { Array as Arr, Effect, Option } from "effect"
import type { Gen } from "#gen.ts"
import { type Generated, forcedChooser, generate, recorder } from "#source.ts"
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

/** Values with the runs `[first, firstEnd)` and `[second, secondEnd)` exchanged, the decisions between them kept. */
const swapped = (
	values: Float64Array,
	first: number,
	firstEnd: number,
	second: number,
	secondEnd: number
) => {
	const copy = values.slice()
	const later = values.subarray(second, secondEnd)
	copy.set(later, first)
	copy.set(values.subarray(firstEnd, second), first + later.length)
	copy.set(values.subarray(first, firstEnd), secondEnd - (firstEnd - first))
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

/** The `array` span an `element` span belongs to: the nearest array one level out that contains it. */
const arrayOf = (tape: Tape, element: number): Option.Option<number> => {
	const depth = (tape.spanDepth[element] ?? 0) - 1
	const start = tape.spanStart[element] ?? 0
	const end = tape.spanEnd[element] ?? 0
	for (let span = 0; span < tape.spanLabel.length; span += 1) {
		if (
			tape.spanLabel[span] === "array" &&
			tape.spanDepth[span] === depth &&
			(tape.spanStart[span] ?? 0) < start &&
			(tape.spanEnd[span] ?? 0) >= end
		) {
			return Option.some(span)
		}
	}
	return Option.none()
}

/**
 * Shrinks a failing attempt by editing its tape. Every pass proposes smaller values; `attempt` runs them and reports
 * the tape it really drew, which counts only when it is strictly smaller in shortlex order and still fails, so
 * shrinking always ends and only ever moves toward simpler cases. A cut attempt ends shrinking at once, with the
 * smallest failing case so far. The passes, in order of how much each removes:
 * - delete one item of a collection (its span, and one off the collection's length);
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
		let best = failing
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
					best = { tape: result.tape, failure: result.failure }
					forgetAboveBest()
					return true
			}
		})

		const deleteItems = Effect.fnUntraced(function* () {
			let progressed = false
			for (let span = best.tape.spanLabel.length - 1; span >= 0 && !exhausted(); span -= 1) {
				if (best.tape.spanLabel[span] !== "element") {
					continue
				}
				const parent = arrayOf(best.tape, span)
				if (Option.isNone(parent)) {
					continue
				}
				const lengthAt = best.tape.spanStart[parent.value] ?? 0
				const shorter = without(
					best.tape.values,
					best.tape.spanStart[span] ?? 0,
					best.tape.spanEnd[span] ?? 0
				)
				shorter[lengthAt] = (shorter[lengthAt] ?? 0) - 1
				progressed = (yield* propose(shorter)) || progressed
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

		const reorderItems = Effect.fnUntraced(function* () {
			let progressed = false
			for (let span = 0; span < best.tape.spanLabel.length && !exhausted(); span += 1) {
				if (best.tape.spanLabel[span] !== "element") {
					continue
				}
				let later = nextItemOf(best.tape, span)
				while (Option.isSome(later) && !exhausted()) {
					progressed =
						(yield* propose(
							swapped(
								best.tape.values,
								best.tape.spanStart[span] ?? 0,
								best.tape.spanEnd[span] ?? 0,
								best.tape.spanStart[later.value] ?? 0,
								best.tape.spanEnd[later.value] ?? 0
							)
						)) || progressed
					later = nextItemOf(best.tape, later.value)
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
		return { best, candidates, ended: endOf() }
	})

/** Shrinks a failing case of a plain generator against a predicate that says whether a value still fails, every
 * candidate generated on one recorder's buffers. */
export const shrink = <A, R>(
	generator: Gen<A>,
	failing: Generated<A>,
	stillFails: (value: A) => Effect.Effect<boolean, never, R>,
	budget: ShrinkBudget
): Effect.Effect<Shrunk<A>, never, R> =>
	Effect.suspend(() => {
		const recorded = recorder()
		return shrinkAttempt(
			{ tape: failing.tape, failure: failing.value },
			(values): Effect.Effect<Attempt<A>, never, R> => {
				const candidate = generate(recorded, generator, forcedChooser(values, values.length))
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
	})
