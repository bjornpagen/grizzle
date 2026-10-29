import { Array as Arr, Option } from "effect"

/** A situation a suite must reach: one feature, or an ordered pair of features noted by one case. */
export type Reached<F extends string> = F | readonly [first: F, second: F]

/**
 * A suite's vocabulary of situations, as a closed union of literals. A plain `string` is refused, so a misspelt feature
 * is a type error, never a requirement nothing can meet.
 */
export type ClosedVocabulary<F extends string> = string extends F ? never : F

/**
 * The situations a suite must reach, and its reach margin. Features are the suite's own model of what matters, so they
 * steer and count, but never constrain what is generated: a feature is a fact about a case worth noticing, never noise
 * such as an id, a count or a piece of SQL text, which would make every case look new. Any generated case reaching a
 * requirement meets it; the reach margin also asks that many of the cases that sample the generator (an exploration's
 * independent cases, an exhaustion's every case) reach each requirement, so a requirement met only by a floor or a
 * steered case, or by a lucky handful of rotating ones, fails the run with ReachBelowMargin before a fresh seed misses
 * it. A margin of zero asks nothing more.
 */
export type Features<F extends string> = Readonly<{
	required: ReadonlyArray<Reached<F>>
	reachMargin: number
}>

/** Declares a suite's required situations, with no reach margin. */
export const features = <F extends string>(
	required: ReadonlyArray<Reached<ClosedVocabulary<F>>>
): Features<F> => ({ required, reachMargin: 0 })

/** A suite's required situations, each of which at least `cases` of the cases that sample its generator must reach. */
export const withReachMargin = <F extends string>(
	declared: Features<F>,
	cases: number
): Features<F> => ({ ...declared, reachMargin: cases })

/** A suite that requires no situation. */
export const noFeatures: Features<never> = { required: [], reachMargin: 0 }

const PAIR_SEPARATOR = " → "

/** The tally key of a situation. */
export const keyOf = <F extends string>(reached: Reached<F>): string =>
	typeof reached === "string" ? reached : `${reached[0]}${PAIR_SEPARATOR}${reached[1]}`

/**
 * Where a tally's cases came from. Kept cases replay by value; floor cases come from the label's fixed stream; steered
 * cases were chosen because they reached something new; independent cases are fresh draws from the run's own stream.
 * Only independent cases are a sample of the generator's distribution, so only they estimate what is still unseen.
 */
export type Phase = "kept" | "floor" | "steered" | "independent" | "exhaustive"

/** The phases whose cases a generator produced, so they may satisfy a required situation. */
export type GeneratedPhase = Exclude<Phase, "kept">

/** How often each situation was reached, by the cases of one phase. */
export type Tally<P extends Phase> = Readonly<{
	phase: P
	cases: number
	counts: ReadonlyMap<string, number>
}>

/** A tally being filled. */
export type TallyBuilder<P extends Phase> = Readonly<{
	add: (notes: ReadonlySet<string>) => void
	has: (key: string) => boolean
	tally: () => Tally<P>
}>

/** Starts a tally of one phase. */
export const tallyOf = <P extends Phase>(phase: P): TallyBuilder<P> => {
	let cases = 0
	const counts = new Map<string, number>()
	return {
		add: (notes) => {
			cases += 1
			for (const key of notes) {
				counts.set(key, (counts.get(key) ?? 0) + 1)
			}
		},
		has: (key) => counts.has(key),
		tally: () => ({ phase, cases, counts: new Map(counts) })
	}
}

/**
 * The Good–Turing estimate of what a suite has not yet seen, from independent cases alone: `risk` is the chance the
 * next case reaches a situation no case reached (singletons over cases), and `unseen` is Chao1's estimate of how many
 * situations no case reached. Both measure the generator and its features, never the program: a bug can hide inside a
 * situation seen a thousand times, so a low risk says no new situation is coming soon, not that no bug remains.
 */
export type Residual = Readonly<{
	cases: number
	observed: number
	singletons: number
	doubletons: number
	risk: Option.Option<number>
	unseen: Option.Option<number>
}>

/** The residual of an independent tally. Only an independent tally is accepted: steered, kept and floor cases are not a
 * sample of the generator's distribution. */
export const residualOf = (tally: Tally<"independent">): Residual => {
	const counts = Arr.fromIterable(tally.counts.values())
	const singletons = Arr.filter(counts, (count) => count === 1).length
	const doubletons = Arr.filter(counts, (count) => count === 2).length
	return {
		cases: tally.cases,
		observed: counts.length,
		singletons,
		doubletons,
		risk: tally.cases === 0 ? Option.none() : Option.some(singletons / tally.cases),
		unseen:
			tally.cases === 0
				? Option.none()
				: Option.some(
						doubletons > 0
							? (singletons * singletons) / (2 * doubletons)
							: (singletons * (singletons - 1)) / 2
					)
	}
}

/** How many cases of a tally reached a situation, by its key. */
const countIn = (tally: Tally<Phase>, key: string): number => tally.counts.get(key) ?? 0

/**
 * The places among a suite's requirements of those no generated case reached, ascending. Kept cases never count: a
 * kept case can hide a generator that stopped drawing a situation, which is exactly what this check exists to catch.
 */
export const pendingOf = <F extends string>(
	declared: Features<F>,
	generated: ReadonlyArray<Tally<GeneratedPhase>>
): ReadonlyArray<number> =>
	Arr.flatMap(declared.required, (situation, place) =>
		Arr.every(generated, (tally) => countIn(tally, keyOf(situation)) === 0) ? [place] : []
	)

/** The keys of the requirements at these places. */
export const keysAt = <F extends string>(
	declared: Features<F>,
	places: ReadonlyArray<number>
): ReadonlyArray<string> =>
	Arr.map(places, (place) => keyOf(Arr.getUnsafe(declared.required, place)))

/**
 * What a steered case may read of its run, of the required situations no generated case had reached when its window
 * began: whether a situation is among them, and whether a feature is named by one of them, alone or in a pair. Both
 * take a situation and answer, so a case of a suite's features is a case of any narrower feature set, as `note` and
 * `pair` already make it. A situation the suite does not require is never pending. A replay token records exactly
 * this, by the places of the pending requirements, so a replayed case steers as its case did.
 */
export type Pending<F extends string> = Readonly<{
	has: (situation: Reached<F>) => boolean
	names: (feature: F) => boolean
}>

/** The pending requirements at these places among a suite's own. */
export const pendingAt = <F extends string>(
	declared: Features<F>,
	places: ReadonlyArray<number>
): Pending<F> => {
	const situations = Arr.map(places, (place) => Arr.getUnsafe(declared.required, place))
	const keys = new Set(Arr.map(situations, keyOf))
	const named = new Set(
		Arr.flatMap(situations, (situation): ReadonlyArray<F> =>
			typeof situation === "string" ? [situation] : situation
		)
	)
	return {
		has: (situation) => keys.has(keyOf(situation)),
		names: (feature) => named.has(feature)
	}
}

/**
 * How a passing exploration reached one requirement: how many of its floor, steered and independent cases reached it,
 * and `miss`, the estimated chance that a run with a fresh seed reaches it in no generated case. The floor stream is
 * fixed by the suite's label, so a requirement a floor case reached is reached on every seed, and its miss is 0.
 * Otherwise the estimate is (1 − k/n)^n, the chance that n fresh independent cases all miss a requirement that k of
 * the run's n independent cases reached, taking k/n as the chance one case reaches it: about e^−k, so a reach margin
 * of m bounds it near e^−m. A steered phase only adds reaches, so where one runs the estimate is an upper bound.
 */
export type Reach = Readonly<{
	requirement: string
	floor: number
	steered: number
	independent: number
	miss: number
}>

/** Every requirement's reach, in the order the suite declares them. */
export const reachOf = <F extends string>(
	declared: Features<F>,
	floor: Tally<"floor">,
	steered: Tally<"steered">,
	independent: Tally<"independent">
): ReadonlyArray<Reach> =>
	Arr.map(declared.required, (situation) => {
		const requirement = keyOf(situation)
		const reached = countIn(independent, requirement)
		const n = independent.cases
		return {
			requirement,
			floor: countIn(floor, requirement),
			steered: countIn(steered, requirement),
			independent: reached,
			miss: countIn(floor, requirement) > 0 ? 0 : n === 0 ? 1 : (1 - reached / n) ** n
		}
	})

/** A requirement the cases that sample its generator reached fewer times than the suite's reach margin asks. */
export type Short = Readonly<{ requirement: string; reached: number }>

/** The requirements under the suite's reach margin in a tally of the cases that sample its generator. */
export const shortOf = <F extends string>(
	declared: Features<F>,
	sampled: Tally<"independent" | "exhaustive">
): ReadonlyArray<Short> =>
	Arr.flatMap(declared.required, (situation) => {
		const reached = countIn(sampled, keyOf(situation))
		return reached < declared.reachMargin ? [{ requirement: keyOf(situation), reached }] : []
	})
