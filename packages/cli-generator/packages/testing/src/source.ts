import { Array as Arr } from "effect"
import { biased, caseSeed, type Stream, type Words, wordsOf } from "#random.ts"
import type { Status, Tape } from "#tape.ts"

/** Whether what the system decided matches the tape being replayed: always, on a fresh tape. */
export type Observed = "as-recorded" | "diverged"

/**
 * What a generator draws its decisions from. `choose` makes one bounded decision; `draw` runs another generator on
 * the same decisions, so a struct, a tuple or a dependent value is a plain function body; `span` labels the decisions a
 * generator makes while it runs, so a tape keeps its structure (`open` and `close` do the same without allocating, for
 * a combinator's loop, and must pair); `discard` gives the case up, for a filter that found nothing it keeps;
 * `observe` records a value the system under test decided, not the test, as a decision with one possible value, and
 * says whether a replay recorded the same one there; an observation a replay lacks is new, never an overrun. A generator never sees where the values come from: a random
 * stream, a replay, an enumeration or a shrink candidate are all the same to it.
 */
export type Source = Readonly<{
	choose: (lo: number, hi: number) => number
	draw: <A>(generator: (source: Source) => A) => A
	span: <A>(label: string, generate: () => A) => A
	open: (label: string) => void
	close: () => void
	discard: () => void
	observe: (value: number) => Observed
}>

/**
 * Where a recording's values come from: `draw` answers the decision at position `at`, and `exhausted` says a replay
 * has no value for it, so the recording finishes on simplest values.
 */
export type Chooser = Readonly<{
	exhausted: (at: number) => boolean
	draw: (lo: number, hi: number, at: number) => number
}>

/** Fresh decisions from a seeded word source, leaning toward the ends of a wide range. */
export const randomChooser = (words: Words): Chooser => ({
	exhausted: () => false,
	draw: (lo, hi) => biased(words, lo, hi)
})

/** The simplest value of every decision: what an enumeration takes past its prefix. */
export const simplestChooser: Chooser = {
	exhausted: () => false,
	draw: (lo) => lo
}

/** Exactly the first `length` of these values, and nothing after them: a replay, or a shrink candidate. */
export const forcedChooser = (values: Float64Array, length: number): Chooser => ({
	exhausted: (at) => at >= length,
	draw: (_lo, _hi, at) => values[at] ?? 0
})

/** The first `length` of these values, then whatever `then` chooses: a mutation's prefix, or an enumeration's branch. */
export const prefixChooser = (values: Float64Array, length: number, then: Chooser): Chooser => ({
	exhausted: (at) => at >= length && then.exhausted(at),
	draw: (lo, hi, at) => (at < length ? (values[at] ?? 0) : then.draw(lo, hi, at))
})

/** A generated value and the tape that determines it. */
export type Generated<A> = Readonly<{ value: A; tape: Tape }>

/**
 * A live recording: the source a case draws from, how many decisions it has made, and a snapshot of its tape so far. A property keeps drawing from the
 * same source after its value is generated, so those draws replay and shrink with the case.
 */
export type Recording = Readonly<{
	source: Source
	status: () => Status
	decided: () => number
	tape: () => Tape
}>

/**
 * A recording that can start over: `reset` begins a new case against a new chooser on the same buffers, so a search
 * that runs case after case allocates its buffers once.
 */
export type Recorder = Recording & Readonly<{ reset: (chooser: Chooser) => void }>

const INITIAL_CAPACITY = 32

/** A buffer `factor` times the size, holding the old one's contents. */
const grownFloat = (buffer: Float64Array, factor: number) => {
	const grown = new Float64Array(buffer.length * factor)
	grown.set(buffer)
	return grown
}

const grownInt = (buffer: Int32Array, factor: number) => {
	const grown = new Int32Array(buffer.length * factor)
	grown.set(buffer)
	return grown
}

/**
 * Records every decision and span made against its chooser. Decisions are packed three numbers apiece (value, lowest,
 * highest) into one buffer, and spans three apiece (start, end, depth) into another, each doubling when full, so a
 * decision costs a few stores and a recording two allocations. A tape is copied out only when someone asks for it,
 * which a passing case never does. A value the chooser cannot give, because a replay ran out or its value no longer
 * fits the decision, becomes the decision's simplest value and marks the recording `overrun`: it still completes,
 * deterministically, and shrinking may still accept it. A decision with one possible value is no decision: it gives
 * that value and records nothing, so a choice among one option never lengthens a tape, and a kept case whose property
 * passes through one still draws nothing.
 */
export const recorder = (): Recorder => {
	let chooser: Chooser = simplestChooser
	let decisions = new Float64Array(INITIAL_CAPACITY * 3)
	let length = 0
	let spans = new Int32Array(INITIAL_CAPACITY * 3)
	const spanLabel: Array<string> = []
	let open = new Int32Array(INITIAL_CAPACITY)
	let depth = 0
	let status: Status = "complete"
	const append = (value: number, lo: number, hi: number) => {
		const at = length * 3
		if (at === decisions.length) {
			decisions = grownFloat(decisions, 2)
		}
		decisions[at] = value
		decisions[at + 1] = lo
		decisions[at + 2] = hi
		length += 1
		return value
	}
	const source: Source = {
		draw: (inner) => inner(source),
		choose: (lo, hi) => {
			if (lo === hi) {
				return lo
			}
			const offered = chooser.exhausted(length) ? lo - 1 : chooser.draw(lo, hi, length)
			const fits = offered >= lo && offered <= hi
			if (!fits && status === "complete") {
				status = "overrun"
			}
			return append(fits ? offered : lo, lo, hi)
		},
		open: (label) => {
			const index = spanLabel.length
			spanLabel.push(label)
			if (index * 3 === spans.length) {
				spans = grownInt(spans, 2)
			}
			spans[index * 3] = length
			spans[index * 3 + 2] = depth
			if (depth === open.length) {
				open = grownInt(open, 2)
			}
			open[depth] = index
			depth += 1
		},
		close: () => {
			depth -= 1
			spans[(open[depth] ?? 0) * 3 + 1] = length
		},
		span: (label, run) => {
			source.open(label)
			const value = run()
			source.close()
			return value
		},
		discard: () => {
			status = "discarded"
		},
		observe: (value) => {
			const offered = chooser.exhausted(length) ? value : chooser.draw(value, value, length)
			append(value, value, value)
			return offered === value ? "as-recorded" : "diverged"
		}
	}
	return {
		source,
		reset: (next) => {
			chooser = next
			length = 0
			spanLabel.length = 0
			depth = 0
			status = "complete"
		},
		status: () => status,
		decided: () => length,
		tape: () => {
			const values = new Float64Array(length)
			const lo = new Float64Array(length)
			const hi = new Float64Array(length)
			for (let at = 0; at < length; at += 1) {
				values[at] = decisions[at * 3] ?? 0
				lo[at] = decisions[at * 3 + 1] ?? 0
				hi[at] = decisions[at * 3 + 2] ?? 0
			}
			const count = spanLabel.length
			const spanStart = new Int32Array(count)
			const spanEnd = new Int32Array(count)
			const spanDepth = new Int32Array(count)
			for (let at = 0; at < count; at += 1) {
				spanStart[at] = spans[at * 3] ?? 0
				spanEnd[at] = spans[at * 3 + 1] ?? 0
				spanDepth[at] = spans[at * 3 + 2] ?? 0
			}
			return {
				length,
				values,
				lo,
				hi,
				spanStart,
				spanEnd,
				spanDepth,
				spanLabel: Arr.copy(spanLabel),
				status
			}
		}
	}
}

/** A fresh recording against one chooser. */
export const recording = (chooser: Chooser): Recording => {
	const started = recorder()
	started.reset(chooser)
	return started
}

/**
 * Runs a generator against a chooser on a recorder's buffers, which it starts over first: the value, and the tape that
 * determines it, copied out of the buffers. A loop that generates case after case (an enumeration, a shrink, a sample)
 * holds one recorder for all of them, so it allocates its buffers once, as an exploration's pool does.
 */
export const generate = <A>(
	recorded: Recorder,
	generator: (source: Source) => A,
	chooser: Chooser
): Generated<A> => {
	recorded.reset(chooser)
	const value = generator(recorded.source)
	return { value, tape: recorded.tape() }
}

/**
 * The first `count` cases of a stream, by value. A pure function of the generator and the stream, so another process
 * given the same stream draws the same cases: a type batch or an agreement suite can generate its inputs ahead of
 * time. A stream is minted only by random.ts, from a suite's label or from the run's seed, never written as a literal.
 */
export const sample = <A>(
	generator: (source: Source) => A,
	stream: Stream,
	count: number
): ReadonlyArray<A> => {
	const recorded = recorder()
	return Arr.makeBy(
		count,
		(index) => generate(recorded, generator, randomChooser(wordsOf(caseSeed(stream, index)))).value
	)
}
