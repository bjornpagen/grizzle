/** What the properties of deadline.test.ts read: its spaces, models and helpers. */

import { type Aimed, aimed, array, type Gen, int } from "@bjornpagen/testing/gen"

/** The features a case shows. */
export type Feature =
	| "a stream silent from its start"
	| "a message one millisecond short of the deadline"
	| "a stream standing one millisecond short of it"
	| "a stream heard several times before its end"
	| "a timeout of 0"

/**
 * A case: whether the timeout is 0, the deadline's milliseconds, how far short of it a silent stream is first looked
 * at, and the gaps of silence before each message the stream hears.
 */
interface Silence {
	readonly disabled: boolean
	readonly millis: number
	readonly shortBy: number
	readonly gaps: ReadonlyArray<number>
}

const silenceGen: Gen<Silence> = (s) => {
	const millis = s.draw(int(1, 40))
	return {
		disabled: s.draw(int(0, 3)) === 0,
		millis,
		shortBy: s.draw(int(1, millis)),
		gaps: s.draw(array(int(0, 60), { min: 0, max: 8 }))
	}
}

/**
 * A stream under a deadline that hears a message one millisecond short of it: gaps within the deadline, then one of
 * the deadline less a millisecond, then any.
 */
const shortGapGen: Gen<Silence> = (s) => {
	const millis = s.draw(int(1, 40))
	return {
		disabled: false,
		millis,
		shortBy: s.draw(int(1, millis)),
		gaps: [
			...s.draw(array(int(0, millis - 1), { min: 0, max: 3 })),
			millis - 1,
			...s.draw(array(int(0, 60), { min: 0, max: 4 }))
		]
	}
}

/** Streams under drawn deadlines and silences, aimed at a message one millisecond short of the deadline while pending. */
export const silenceSpace: Aimed<Silence, Feature> = aimed(silenceGen, [
	["a message one millisecond short of the deadline", shortGapGen]
])
