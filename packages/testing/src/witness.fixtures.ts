import { Duration, Formatter } from "effect"
import { drawn, type Exhaustion, type Exploration } from "#explore.ts"
import {
	type Coverage,
	noCoverage,
	required,
	requiredInSpace,
	residualOf,
	tallyOf,
	unreachedOf
} from "#features.ts"
import { int } from "#gen.ts"
import { caseSeed, floorSeed, fuzzSeed, rotatingSeed, steeredSeed } from "#random.ts"
import { notesOnly } from "#sense.ts"
import { boundedShrink } from "#shrink.ts"
import { sample } from "#source.ts"

/**
 * The type tier of the witness verdict, checked by the package's typecheck: each `accepted` entry compiles, and each
 * `refused` entry is a type error its directive names, so a change that lets a case the run's seed drew decide a
 * verdict, or a witness phase draw from the run's seed, fails here before any test runs.
 */
const floor = floorSeed("witness types")

const rotating = rotatingSeed(0, floor)

const exploration = (coverage: Coverage<"a">): Exploration<number, number, "a"> => ({
	suite: "witness types",
	draw: drawn(int(0, 9)),
	literal: Formatter.format,
	coverage,
	kept: [],
	runs: 4,
	shrink: boundedShrink(0),
	concurrency: 1,
	steerEvery: 4,
	caseHang: Duration.seconds(1)
})

const exhaustion = (coverage: Exhaustion<number, "a">["coverage"]): Exhaustion<number, "a"> => ({
	suite: "witness types",
	generator: int(0, 9),
	literal: Formatter.format,
	limit: 10,
	coverage,
	caseHang: Duration.seconds(1)
})

export const accepted = Object.freeze([
	sample(int(0, 9), floor, 1),
	sample(int(0, 9), rotating, 1),
	caseSeed(steeredSeed(floor), 0),
	caseSeed(fuzzSeed(rotating), 0),
	unreachedOf<"a">(
		["a"],
		[tallyOf("floor").tally(), tallyOf("steered").tally(), tallyOf("exhaustive").tally()]
	),
	residualOf(tallyOf("independent").tally()),
	exploration(required<"a">(["a"], { cases: 0, sense: notesOnly })),
	exploration(noCoverage),
	exhaustion(requiredInSpace<"a">(["a"])),
	exhaustion(noCoverage)
])

export const refused = Object.freeze([
	// @ts-expect-error -- a literal is no stream: a stream is minted from a suite's label or from the run's seed
	sample(int(0, 9), 7, 1),
	// @ts-expect-error -- a literal is no stream
	caseSeed(7, 0),
	// @ts-expect-error -- the steered phase grows from the label-fixed floor, never from a run-drawn stream
	steeredSeed(rotating),
	// @ts-expect-error -- a rotating stream is derived from a floor stream, never from another run-drawn one
	rotatingSeed(0, rotating),
	// @ts-expect-error -- a fuzz run's stream is derived from the run's rotating stream, never from a witness's
	fuzzSeed(floor),
	// @ts-expect-error -- an independent case never meets or misses a requirement
	unreachedOf<"a">(["a"], [tallyOf("independent").tally()]),
	// @ts-expect-error -- a fuzz run's case never meets or misses a requirement
	unreachedOf<"a">(["a"], [tallyOf("fuzzed").tally()]),
	// @ts-expect-error -- the residual is the independent sample's alone, never a witness's
	residualOf(tallyOf("floor").tally()),
	// @ts-expect-error -- a requirement names one situation or more; requiring none is noCoverage
	required<"a">([], { cases: 0, sense: notesOnly }),
	// @ts-expect-error -- a requirement steers: it states its steered phase
	required<"a">(["a"]),
	// @ts-expect-error -- a vocabulary is a closed union of literals, never a plain string
	required<string>(["a"], { cases: 0, sense: notesOnly }),
	// @ts-expect-error -- an exploration's requirement states the steered phase that reaches what its floor misses
	exploration(requiredInSpace<"a">(["a"])),
	// @ts-expect-error -- steering exists only inside a requirement, never beside no coverage
	exploration({ kind: "none", steered: { cases: 1, sense: notesOnly } })
])
