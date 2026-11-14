import { Array as Arr, Option } from "effect"
import type { Gen } from "#gen.ts"
import { floorSeed } from "#random.ts"
import type { Sense } from "#sense.ts"
import { sample } from "#source.ts"

/** A situation a suite must reach: one feature, or an ordered pair of features noted by one case. */
export type Reached<F extends string> = F | readonly [first: F, second: F]

/**
 * A suite's vocabulary of situations, as a closed union of literals. A plain `string` is refused, so a misspelt feature
 * is a type error, never a requirement nothing can meet.
 */
export type ClosedVocabulary<F extends string> = string extends F ? never : F

/**
 * A search's required situations: one or more, each a feature or an ordered pair. Features are the suite's own model of
 * what matters, so they steer and count, but never constrain what is generated: a feature is a fact about a case worth
 * noticing, never noise such as an id, a count or a piece of SQL text, which would make every case look new.
 */
export type Situations<F extends string> = Arr.NonEmptyReadonlyArray<Reached<F>>

/**
 * The steered phase of an exploration that requires situations: up to `cases` cases grown from the floor's finds by
 * `sense`, on a stream the suite's label fixes, run only while a required situation is unreached. A budget of zero is
 * the floor stream alone.
 */
export type SteeredPhase = Readonly<{ cases: number; sense: Sense }>

/**
 * What an exploration must reach: nothing, or situations together with the steered phase that reaches what the floor
 * stream misses. Only the floor's and the steered phase's cases count, and the suite's label fixes both, so a
 * requirement is met on every run seed or on none. The rotating stream is the run's sample: it finds failures and
 * feeds the residual, and never meets or misses a requirement. A kept case never counts either. A required coverage
 * also names the features whose rate among the independent cases the residual reports (`rated`), none unless a suite
 * rates some (rating).
 */
export type Coverage<F extends string> = Readonly<{ kind: "none" }> | RequiredCoverage<F>

/** A coverage that requires situations, and the features whose rate it reports. */
export type RequiredCoverage<F extends string> = Readonly<{
	kind: "required"
	situations: Situations<F>
	steered: SteeredPhase
	rated: ReadonlyArray<F>
}>

/** What an exhaustion must reach: every case of its space is a witness, so it has no steered phase. */
export type SpaceCoverage<F extends string> =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "required"; situations: Situations<F> }>

/** An exploration's required situations, and the steered phase that reaches what its floor stream misses. */
export const required = <F extends string>(
	situations: Arr.NonEmptyReadonlyArray<Reached<ClosedVocabulary<F>>>,
	steered: SteeredPhase
): RequiredCoverage<F> => ({ kind: "required", situations, steered, rated: [] })

/**
 * A required coverage that also reports, beside the residual, how many independent cases reached each of `features`:
 * what a suite whose oracle may decline to judge a case counts, so a class of cases it stops judging is a rate on
 * screen, never silence.
 */
export const rating = <F extends string>(
	coverage: RequiredCoverage<F>,
	features: Arr.NonEmptyReadonlyArray<ClosedVocabulary<F>>
): RequiredCoverage<F> => ({ ...coverage, rated: features })

/** How many of an exploration's independent cases reached a feature its coverage rates. */
export type Rate = Readonly<{ feature: string; cases: number }>

/** The rates an independent tally gives the features a coverage rates, in their order. */
export const ratesOf = <F extends string>(
	coverage: Coverage<F>,
	tally: Tally<"independent">
): ReadonlyArray<Rate> => {
	switch (coverage.kind) {
		case "none":
			return []
		case "required":
			return Arr.map(coverage.rated, (feature) => ({
				feature,
				cases: tally.counts.get(feature) ?? 0
			}))
	}
}

/** An exhaustion's required situations, judged on every case of its space. */
export const requiredInSpace = <F extends string>(
	situations: Arr.NonEmptyReadonlyArray<Reached<ClosedVocabulary<F>>>
): SpaceCoverage<F> => ({ kind: "required", situations })

/** A search that requires no situation, and so runs no steered phase. */
export const noCoverage: Readonly<{ kind: "none" }> = { kind: "none" }

/** The situations a search requires, in declared order: none under `none`. */
export const situationsOf = <F extends string>(
	coverage: Coverage<F> | SpaceCoverage<F>
): ReadonlyArray<Reached<F>> => {
	switch (coverage.kind) {
		case "none":
			return []
		case "required":
			return coverage.situations
	}
}

const PAIR_SEPARATOR = " → "

/** The tally key of a situation. */
export const keyOf = <F extends string>(reached: Reached<F>): string =>
	typeof reached === "string" ? reached : `${reached[0]}${PAIR_SEPARATOR}${reached[1]}`

/**
 * The phases a suite's label fixes: the floor stream, the steered phase grown from it, and an exhaustion's every case.
 * They are the suite's witnesses: a requirement, a stall and a required kill are judged on these alone, so no such
 * verdict moves with TEST_SEED.
 */
export type WitnessPhase = "floor" | "steered" | "exhaustive"

/**
 * Every phase whose cases are tallied: the witnesses; the rotating stream's independent cases, fresh draws from the
 * run's own stream and the only sample of the generator's distribution, so the only estimate of what is still unseen;
 * and a fuzz run's run-seeded cases, which steer that run and decide nothing.
 */
export type Phase = WitnessPhase | "independent" | "fuzzed"

/** The phases whose tallies steer: what a steered case's Pending and a seed's pick read. */
export type SteeringPhase = Exclude<Phase, "independent">

/**
 * How often each situation was reached by the cases of one phase, and how many of its last cases in a row reached no situation an earlier case of it had not (`sinceNew`): all of them when none
 * reached any.
 */
export type Tally<P extends Phase> = Readonly<{
	phase: P
	cases: number
	counts: ReadonlyMap<string, number>
	sinceNew: number
}>

/** A tally being filled: a passing case adds its notes. */
export type TallyBuilder<P extends Phase> = Readonly<{
	phase: P
	add: (notes: ReadonlySet<string>) => void
	tally: () => Tally<P>
}>

/** Starts a tally of one phase. */
export const tallyOf = <P extends Phase>(phase: P): TallyBuilder<P> => {
	let cases = 0
	let lastNew = 0
	const counts = new Map<string, number>()
	return {
		phase,
		add: (notes) => {
			cases += 1
			for (const key of notes) {
				const count = counts.get(key) ?? 0
				if (count === 0) {
					lastNew = cases
				}
				counts.set(key, count + 1)
			}
		},
		tally: () => ({ phase, cases, counts: new Map(counts), sinceNew: cases - lastNew })
	}
}

/**
 * The chance that a residual's bound is wrong, whatever the generator's distribution: the bound holds at 95%, the
 * confidence its line prints.
 */
export const RISK_BOUND_MISS = 0.05

/**
 * What a residual says of the chance that the next independent case reaches a situation no case reached: unknown when
 * no independent case ran, or when none noted a situation (a suite that notes no features measures nothing);
 * otherwise Good–Turing's estimate, the situations seen once over the cases, beside an upper bound that holds at 95%
 * (riskBoundOf). The estimate is 0 whenever every situation was seen twice or more, however few the cases, so the bound
 * is what tells a thorough search from a shallow one.
 */
export type Risk =
	| Readonly<{ kind: "unknown"; why: "no-cases" | "nothing-noted" }>
	| Readonly<{ kind: "estimated"; estimate: number; bound: number }>

/**
 * The upper bound on the chance that the next independent case reaches a situation none reached, after `cases`
 * independent cases whose last `sinceNew` in a row reached none an earlier case had not. It holds with probability at
 * least 1 − RISK_BOUND_MISS whatever the generator's distribution, a case's notes being any set of situations. Were
 * that chance above b, it was above b when the run began, since a case that reaches nothing new leaves it as it was;
 * so each case of the run, drawn independently, missed every new situation with chance below 1 − b, and the whole run
 * did with chance below (1 − b)^sinceNew. Spreading RISK_BOUND_MISS over the `cases` lengths the run can have gives
 * b = 1 − (RISK_BOUND_MISS / cases)^(1 / sinceNew). With no such run the bound is 1: nothing is known.
 */
export const riskBoundOf = (cases: number, sinceNew: number): number =>
	sinceNew === 0 ? 1 : 1 - (RISK_BOUND_MISS / cases) ** (1 / sinceNew)

/**
 * What a suite has not yet seen, from independent cases alone: the risk that the next case reaches a situation no case
 * reached (Risk), how many of the last cases in a row reached none an earlier case had not (`sinceNew`), and `unseen`,
 * Chao1's estimate of how many situations no case reached, none when the risk is unknown. They measure the generator
 * and its features, never the program: a bug can hide inside a situation seen a thousand times, so a low risk says no
 * new situation is coming soon, not that no bug remains.
 */
export type Residual = Readonly<{
	cases: number
	observed: number
	singletons: number
	doubletons: number
	sinceNew: number
	risk: Risk
	unseen: Option.Option<number>
}>

/** The residual of an independent tally. Only an independent tally is accepted: witness, fuzzed and kept cases are not
 * a sample of the generator's distribution. */
export const residualOf = (tally: Tally<"independent">): Residual => {
	const counts = Arr.fromIterable(tally.counts.values())
	const singletons = Arr.filter(counts, (count) => count === 1).length
	const doubletons = Arr.filter(counts, (count) => count === 2).length
	const risk: Risk =
		tally.cases === 0
			? { kind: "unknown", why: "no-cases" }
			: counts.length === 0
				? { kind: "unknown", why: "nothing-noted" }
				: {
						kind: "estimated",
						estimate: singletons / tally.cases,
						bound: riskBoundOf(tally.cases, tally.sinceNew)
					}
	return {
		cases: tally.cases,
		observed: counts.length,
		singletons,
		doubletons,
		sinceNew: tally.sinceNew,
		risk,
		unseen:
			risk.kind === "unknown"
				? Option.none()
				: Option.some(
						doubletons > 0
							? (singletons * singletons) / (2 * doubletons)
							: (singletons * (singletons - 1)) / 2
					)
	}
}

/** Whether no case of these tallies reached a situation. */
const unreachedIn = <F extends string>(
	tallies: ReadonlyArray<Tally<Phase>>,
	situation: Reached<F>
): boolean => Arr.every(tallies, (tally) => !tally.counts.has(keyOf(situation)))

/**
 * The places among a search's required situations of those no case of these steering tallies reached, ascending: what
 * a window's Pending snapshots. Kept cases never count: a kept case can hide a generator that stopped drawing a
 * situation, which is exactly what a requirement exists to catch.
 */
export const pendingOf = <F extends string>(
	situations: ReadonlyArray<Reached<F>>,
	steering: ReadonlyArray<Tally<SteeringPhase>>
): ReadonlyArray<number> =>
	Arr.flatMap(situations, (situation, place) => (unreachedIn(steering, situation) ? [place] : []))

/**
 * The keys of the required situations no witness reached, in declared order: the coverage verdict. It takes witness
 * tallies alone, so no independent case can enter it, and the verdict is the same on every run seed.
 */
export const unreachedOf = <F extends string>(
	situations: Situations<F>,
	witnessed: ReadonlyArray<Tally<WitnessPhase>>
): ReadonlyArray<string> =>
	Arr.flatMap(situations, (situation) =>
		unreachedIn(witnessed, situation) ? [keyOf(situation)] : []
	)

/**
 * The pending places in turn order of the case `offset` turns after the one that follows `after`, of the required
 * situations pending when its window began (their places ascending, as pendingOf gives them): its aim is the
 * `offset`-th pending place after `after`, wrapping, and the rest follow it, ascending and wrapping. A pure function of
 * its arguments, so a stream that runs cases at once gives each its turn before any runs.
 */
export const turnOf = (
	pending: ReadonlyArray<number>,
	after: number,
	offset: number
): ReadonlyArray<number> => {
	const first = Option.getOrElse(
		Arr.findFirstIndex(pending, (place) => place > after),
		() => 0
	)
	return Arr.map(pending, (_, i) => Arr.getUnsafe(pending, (first + offset + i) % pending.length))
}

/**
 * Whose turn each case of a stream's steering windows is (turnOf): the window's i-th case aims at the i-th pending place
 * after the one the stream last aimed at, wrapping, so a window's cases aim at distinct pending requirements while it
 * holds no more cases than there are, and a requirement still pending gets a turn within ⌈pending / window⌉ windows of
 * its stream, whatever the window's size. A stream's turns begin before its first requirement, so its first window's
 * i-th case aims at the i-th pending one.
 */
export type Turns = Readonly<{
	window: (
		pending: ReadonlyArray<number>,
		cases: number
	) => (offset: number) => ReadonlyArray<number>
}>

/** The turns of one stream, none taken yet. */
export const turnsOf = (): Turns => {
	let last = -1
	return {
		window: (pending, cases) => {
			const after = last
			if (cases > 0) {
				last = Option.getOrElse(Arr.head(turnOf(pending, after, cases - 1)), () => after)
			}
			return (offset) => turnOf(pending, after, offset)
		}
	}
}

/**
 * What a steered case may read of its run, of the required situations no case of the steering tallies had reached when
 * its window began: whether a situation is among them; whether a feature is named by one of them, alone or in a pair;
 * and whether a situation is the one this case's turn aims at (Turns), true of exactly one pending situation while any
 * is pending. A suite that aims a case at what is pending aims it at its turn's situation (`aimed`), so the cases of
 * one window aim at distinct requirements and none waits behind another the suite cannot reach. Each takes a situation
 * and answers, so a case of a suite's features is a case of any narrower feature set, as `note` and `pair` already make
 * it. A situation the suite does not require is never pending. A replay token records exactly this, by the places of
 * the pending requirements in turn order, so a replayed case steers as its case did.
 */
export type Pending<F extends string> = Readonly<{
	has: (situation: Reached<F>) => boolean
	names: (feature: F) => boolean
	aimed: (situation: Reached<F>) => boolean
}>

/** The pending requirements at these places among a search's required situations, in turn order, the first aimed. */
export const pendingAt = <F extends string>(
	situations: ReadonlyArray<Reached<F>>,
	places: ReadonlyArray<number>
): Pending<F> => {
	const pending = Arr.map(places, (place) => Arr.getUnsafe(situations, place))
	const keys = new Set(Arr.map(pending, keyOf))
	const named = new Set(
		Arr.flatMap(pending, (situation): ReadonlyArray<F> =>
			typeof situation === "string" ? [situation] : situation
		)
	)
	const aim = Option.map(Arr.head(pending), keyOf)
	return {
		has: (situation) => keys.has(keyOf(situation)),
		names: (feature) => named.has(feature),
		aimed: (situation) => Option.contains(aim, keyOf(situation))
	}
}

/**
 * A population a suite draws ahead of time on its label's floor stream, and the tally of what it reached: the witness
 * an ahead-of-time suite (a type batch) judges its requirements on with `unreachedOf`. The label fixes the population,
 * so its verdict is the same on every run seed.
 */
export const floorPopulation = <A, F extends string>(
	label: string,
	generator: Gen<A>,
	count: number,
	reached: (value: A) => Iterable<Reached<F>>
): Readonly<{ values: ReadonlyArray<A>; tally: Tally<"floor"> }> => {
	const values = sample(generator, floorSeed(label), count)
	const tally = tallyOf("floor")
	for (const value of values) {
		const keys = new Set<string>()
		for (const situation of reached(value)) {
			keys.add(keyOf(situation))
		}
		tally.add(keys)
	}
	return { values, tally: tally.tally() }
}
