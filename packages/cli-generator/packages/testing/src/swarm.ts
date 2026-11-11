import { Array as Arr } from "effect"
import type { Gen } from "#gen.ts"

/** A feature's weight in one case: off, or present at a third, two thirds or every place it could appear. */
export type SwarmWeight = 0 | 1 | 2 | 3

/** The weight of a feature a swarm turns on. */
export type Presence = Exclude<SwarmWeight, 0>

/**
 * One case's swarm: the features it turns on, each at its weight, every feature it does not name being off. Swarm
 * testing randomizes the generator's own settings per case, so each case explores a lopsided corner where features
 * that crowd others out are absent and the rest combine. A swarm is its own literal: a kept case writes
 * `{ join: 3, where: 1 }`, and a feature added to or removed from the generator's list is a type error there.
 */
export type Swarm<F extends string> = Readonly<Partial<Record<F, Presence>>>

/**
 * How many features a case omits, drawn per case, the most omitting first, so a failing case shrinks toward fewer
 * features. Drawing it per case makes cases with few features on as common as cases with most of them on, which one
 * fixed rate never does.
 */
export const OMISSIONS = ["five-sixths", "half", "one-sixth"] as const

export type Omission = (typeof OMISSIONS)[number]

/**
 * A feature's gate is one decision of eighteen values: the first `OFF[omission]` turn it off, and the rest give weights
 * 1, 2 and 3 in equal thirds. Eighteen divides by six and by three, so every rate and every third is exact, and a gate
 * shrinks toward zero, toward the feature being off.
 */
const GATES = 18

const OFF: Readonly<Record<Omission, number>> = { "five-sixths": 15, half: 9, "one-sixth": 3 }

const PRESENCES = [1, 2, 3] as const

/** Draws a swarm over a generator's features: an omission, then one gate per feature in the order given. */
export const swarm =
	<F extends string>(features: Arr.NonEmptyReadonlyArray<F>): Gen<Swarm<F>> =>
	(source) => {
		source.open("swarm")
		const off = OFF[Arr.getUnsafe(OMISSIONS, source.choose(0, OMISSIONS.length - 1))]
		const on: Partial<Record<F, Presence>> = {}
		for (const feature of features) {
			const gate = source.choose(0, GATES - 1)
			if (gate >= off) {
				on[feature] = Arr.getUnsafe(PRESENCES, Math.floor(((gate - off) * 3) / (GATES - off)))
			}
		}
		source.close()
		return on
	}

/** The swarm that turns every feature on at full weight: a generator's behaviour without swarm testing. */
export const fullSwarm = <F extends string>(features: ReadonlyArray<F>): Swarm<F> => {
	const on: Partial<Record<F, Presence>> = {}
	for (const feature of features) {
		on[feature] = 3
	}
	return on
}

/** A feature's weight in a swarm. */
export const weightOf = <F extends string>(drawn: Swarm<F>, feature: F): SwarmWeight =>
	drawn[feature] ?? 0

/**
 * Whether a feature appears at the next place it could: always at weight 3, never when off, and otherwise by one more
 * decision on the case's tape, which shrinks toward leaving it out.
 */
export const keep =
	<F extends string>(drawn: Swarm<F>, feature: F): Gen<boolean> =>
	(source) => {
		const weight = weightOf(drawn, feature)
		return weight === 3 || (weight > 0 && source.choose(0, 2) >= 3 - weight)
	}

/**
 * One of several features, each as often as its weight, shrinking toward the first that is on. When every one is off
 * the choice takes the first, the floor, which the caller names first because it is the simplest valid form: a
 * filter's input, a union's first arm. So no draw is a dead end, and the caller never needs a fallback of its own. When
 * exactly one is on, that one is no choice and draws nothing. It returns the options' own type, so a choice among some
 * of the features keeps that subset.
 */
export const swarmChoice =
	<F extends string, O extends F>(drawn: Swarm<F>, options: Arr.NonEmptyReadonlyArray<O>): Gen<O> =>
	(source) => {
		const on = Arr.filter(options, (option) => weightOf(drawn, option) > 0)
		if (!Arr.isReadonlyArrayNonEmpty(on)) {
			return Arr.headNonEmpty(options)
		}
		if (on.length === 1) {
			return Arr.headNonEmpty(on)
		}
		const total = Arr.reduce(on, 0, (sum, option) => sum + weightOf(drawn, option))
		let rest = source.choose(0, total - 1)
		for (const option of options) {
			rest -= weightOf(drawn, option)
			if (rest < 0) {
				return option
			}
		}
		return Arr.lastNonEmpty(options)
	}
