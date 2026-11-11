import { Option } from "effect"
import { between, type Words } from "#random.ts"
import type { Tape } from "#tape.ts"

/** The values a mutated case replays before its fresh decisions take over. */
export type Mutant = Readonly<{ values: Float64Array; length: number }>

/** How many decisions one mutation edits in place, at most, before its one structural edit. */
const MAX_POINT_EDITS = 4

/**
 * How many decisions a mutation edits in place: one half the time, two a quarter of the time, and so on up to the most,
 * so most mutants change one thing and keep every other value their seed found.
 */
const pointEditsOf = (words: Words): number => {
	let edits = 1
	while (edits < MAX_POINT_EDITS && between(words, 0, 1) === 1) {
		edits += 1
	}
	return edits
}

/** How far a nudge moves a decision, at most. */
const MAX_NUDGE = 16

/** A decision's value moved to one end of its range, nudged, or redrawn anywhere in it. */
const pointEdit = (tape: Tape, values: Float64Array, words: Words) => {
	const at = between(words, 0, tape.length - 1)
	const lo = tape.lo[at] ?? 0
	const hi = tape.hi[at] ?? 0
	const value = values[at] ?? lo
	const nudge = between(words, 1, MAX_NUDGE)
	switch (between(words, 0, 4)) {
		case 0:
			values[at] = lo
			break
		case 1:
			values[at] = hi
			break
		case 2:
			values[at] = Math.min(hi, value + nudge)
			break
		case 3:
			values[at] = Math.max(lo, value - nudge)
			break
		default:
			values[at] = between(words, lo, hi)
	}
}

/** Values with `[start, end)` replaced by `inserted`. */
const replacedRun = (values: Float64Array, start: number, end: number, inserted: Float64Array) => {
	const result = new Float64Array(values.length - (end - start) + inserted.length)
	result.set(values.subarray(0, start))
	result.set(inserted, start)
	result.set(values.subarray(end), start + inserted.length)
	return result
}

/** A span of `donor` with the label `label`, if it has one, chosen by `words`. */
const donorSpan = (donor: Tape, label: string, words: Words): Option.Option<Float64Array> => {
	const matching: Array<number> = []
	for (let span = 0; span < donor.spanLabel.length; span += 1) {
		if (donor.spanLabel[span] === label) {
			matching.push(span)
		}
	}
	if (matching.length === 0) {
		return Option.none()
	}
	const span = matching[between(words, 0, matching.length - 1)] ?? 0
	return Option.some(donor.values.slice(donor.spanStart[span] ?? 0, donor.spanEnd[span] ?? 0))
}

/**
 * One structural edit of a tape: delete a span, repeat it, set it to its simplest, put a same-labelled span of another
 * case in its place, or cut the tape short, so the case continues on fresh decisions. A span is a generated value (an
 * item, a command, a branch), so each edit changes a case the way its generator could have, and the fresh decisions
 * that follow keep the case well-formed.
 */
const structuralEdit = (
	tape: Tape,
	values: Float64Array,
	donor: Option.Option<Tape>,
	words: Words
): Mutant => {
	const spans = tape.spanLabel.length
	const operation = between(words, 0, spans === 0 ? 0 : 4)
	if (operation === 0) {
		return { values, length: between(words, 0, tape.length) }
	}
	const span = between(words, 0, spans - 1)
	const start = tape.spanStart[span] ?? 0
	const end = tape.spanEnd[span] ?? 0
	switch (operation) {
		case 1: {
			const shorter = replacedRun(values, start, end, new Float64Array(0))
			return { values: shorter, length: shorter.length }
		}
		case 2: {
			const longer = replacedRun(values, end, end, values.slice(start, end))
			return { values: longer, length: longer.length }
		}
		case 3: {
			values.set(tape.lo.subarray(start, end), start)
			return { values, length: values.length }
		}
		default: {
			const spliced = Option.match(
				Option.flatMap(donor, (other) => donorSpan(other, tape.spanLabel[span] ?? "", words)),
				{
					onNone: () => values,
					onSome: (inserted) => replacedRun(values, start, end, inserted)
				}
			)
			return { values: spliced, length: spliced.length }
		}
	}
}

/**
 * A mutant of a case's tape: one to four decisions edited in place, one most often, and one time in three a structural
 * edit as well, all chosen by `words`. Most mutants keep a seed's shape, so a value it found stays where its generator
 * reads it.
 * Edits work on the decisions themselves, never on the values a generator builds from them, so any generator mutates
 * with no mutator of its own, and a value a decision can no longer take replays as its simplest.
 */
export const mutate = (tape: Tape, donor: Option.Option<Tape>, words: Words): Mutant => {
	const values = tape.values.slice(0, tape.length)
	if (tape.length > 0) {
		const edits = pointEditsOf(words)
		for (let edit = 0; edit < edits; edit += 1) {
			pointEdit(tape, values, words)
		}
	}
	return tape.length === 0 || between(words, 0, 2) === 0
		? structuralEdit(tape, values, donor, words)
		: { values, length: values.length }
}
