import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option, String as Str } from "effect"
import { type Case, drawn, type Exploration, explore, Run, type Steering } from "#explore.ts"
import { type Features, features } from "#features.ts"
import { array, type Gen, int } from "#gen.ts"
import { notesOnly, type Sense, v8Coverage } from "#sense.ts"
import { completeShrink } from "#shrink.ts"
import { runOfProcess } from "#vitest/run.ts"

const MAGIC = [13, 27, 4, 30, 9] as const

type Matched = `${0 | 1 | 2 | 3 | 4 | 5} matched`

const MATCHED: ReadonlyArray<Matched> = [
	"0 matched",
	"1 matched",
	"2 matched",
	"3 matched",
	"4 matched",
	"5 matched"
]

/** Six values of 0..31: drawn at random, they begin with all five magic values once in 33 million cases. */
const values: Gen<ReadonlyArray<number>> = array(int(0, 31), { min: 6, max: 6 })

/** How many magic values a case begins with. */
const matchedOf = (drawnValues: ReadonlyArray<number>): number => {
	let matched = 0
	while (matched < MAGIC.length && drawnValues[matched] === MAGIC[matched]) {
		matched += 1
	}
	return matched
}

/** This process's run, never replaying or fuzzing: the steered and unsteered searches draw from its seed. */
const run = Effect.map(runOfProcess, (processRun) =>
	Run.of({ ...processRun, replay: Option.none(), fuzz: Option.none() })
)

/** A search that must reach all five magic values, with the given steering. */
const magicSearch = <F extends string>(
	suite: string,
	required: Features<F>,
	steering: Steering,
	concurrency: number
): Exploration<ReadonlyArray<number>, ReadonlyArray<number>, F> => ({
	suite,
	draw: drawn(values),
	literal: Formatter.format,
	features: required,
	kept: [],
	runs: 100,
	shrink: completeShrink,
	concurrency,
	steerEvery: 16,
	steering,
	caseHang: Duration.minutes(1)
})

/** Notes how many magic values the case begins with: each new count is a step a steered search climbs from. */
const noteMatched = (drawnValues: ReadonlyArray<number>, c: Case<Matched>) =>
	Effect.sync(() => c.note(Arr.getUnsafe(MATCHED, matchedOf(drawnValues))))

/**
 * Six values of 0..31 for a lock with five nested branches: drawn at random, they open it once in 33 million cases, so
 * a search that does not perceive the branches never opens it within its budget, whatever the run's seed.
 */
const lockValues: Gen<ReadonlyArray<number>> = array(int(0, 31), { min: 6, max: 6 })

/** Opens only on all five magic values, one nested branch per value, and notes nothing on the way. */
const opens = (drawnValues: ReadonlyArray<number>): boolean => {
	if (drawnValues[0] === MAGIC[0]) {
		if (drawnValues[1] === MAGIC[1]) {
			if (drawnValues[2] === MAGIC[2]) {
				if (drawnValues[3] === MAGIC[3]) {
					if (drawnValues[4] === MAGIC[4]) {
						return true
					}
				}
			}
		}
	}
	return false
}

/** A search for the lock's opening, steered by `sense` for up to `cases` cases, one case at a time. */
const lockSearch = (
	suite: string,
	sense: Sense,
	cases: number
): Exploration<ReadonlyArray<number>, ReadonlyArray<number>, "opened"> => ({
	...magicSearch(suite, features<"opened">(["opened"]), { kind: "mutate", cases, sense }, 1),
	draw: drawn(lockValues)
})

/** Notes only the opening. */
const noteOpened = (drawnValues: ReadonlyArray<number>, c: Case<"opened">) =>
	Effect.sync(() => {
		if (opens(drawnValues)) {
			c.note("opened")
		}
	})

describe("a steered search", () => {
	it.effect("climbs to a situation random search never reaches, one new note at a time", () =>
		Effect.gen(function* () {
			const unsteered = yield* Effect.flip(
				explore(
					magicSearch("unsteered", features<Matched>(["5 matched"]), { kind: "none" }, 4),
					noteMatched
				)
			)
			strictEqual(unsteered._tag, "FeaturesUnreached")
			const steered = yield* explore(
				magicSearch(
					"steered",
					features<Matched>(["5 matched"]),
					{ kind: "mutate", cases: 50_000, sense: notesOnly },
					4
				),
				noteMatched
			)
			strictEqual(steered.residual.cases, 100)
		}).pipe(Effect.provideServiceEffect(Run, run))
	)

	it.effect("finds the same cases however many run at once", () =>
		Effect.gen(function* () {
			const explored = yield* Effect.forEach([1, 4, 16], (concurrency) =>
				explore(
					magicSearch(
						"steered at any concurrency",
						features<Matched>(["5 matched"]),
						{ kind: "mutate", cases: 50_000, sense: notesOnly },
						concurrency
					),
					noteMatched
				)
			)
			deepStrictEqual(Arr.dedupe(Arr.map(explored, (search) => search.cases)), [
				Arr.getUnsafe(explored, 0).cases
			])
		}).pipe(Effect.provideServiceEffect(Run, run))
	)

	it.effect(
		"climbs through branches it perceives in V8's block coverage, with no note on the way",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const sense = yield* v8Coverage(Str.endsWith("/steer.test.ts"))
					const blind = yield* Effect.flip(
						explore(lockSearch("blind", notesOnly, 1000), noteOpened)
					)
					strictEqual(blind._tag, "FeaturesUnreached")
					yield* explore(lockSearch("coverage", sense, 100_000), noteOpened)
				}).pipe(Effect.provideServiceEffect(Run, run))
			),
		0
	)
})
