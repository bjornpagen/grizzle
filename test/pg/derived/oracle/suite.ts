import { layer } from "@effect/vitest"
import { drawn } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Formatter } from "effect"
import { aggregateKeys, caseSketchGen, plantedAggregates } from "#test/pg/derived/oracle/gen.ts"
import { type DerivedFeature, derivedCase } from "#test/pg/derived/oracle/property.ts"
import { oracleCheck } from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Cases per seed and stream: each installs a schema, opens a Db and makes three to six refresh calls.
 *
 * The generated refresh oracle's suites. Each seed is a top-level suite of its own, so a file's
 * suites overlap their database waits (Writing tests); every case is installed under its own schema. */
const casesPerSeed = 200

/** What every seed's cases must reach, so the oracle is not vacuous: every feature a case notes, each aggregate over
 * every kind it takes, the four over an aggregate's own result planted (`plantedNumSketchGen`), and a second reading
 * over a respelled value. */
const situations: Arr.NonEmptyReadonlyArray<DerivedFeature> = [
	"form rule",
	"form union",
	"form take",
	"level 2",
	"level 3",
	"negation",
	...aggregateKeys,
	"plain statements",
	"concurrent statements",
	"nonempty views",
	"no-change checks",
	"unaffected-view checks",
	"multi-view commits",
	"unpopulated reads",
	"identical reloads",
	"reordered reloads",
	"base changes",
	"a fact respelled on a second reading"
]

/** One suite's cases, explored: the kept case, the floor stream the library derives from the suite's label, and the
 * run's rotating stream. */
const explored = (suite: string) =>
	oracleCheck(
		drawn(caseSketchGen),
		{
			suite,
			literal: Formatter.format,
			coverage: required<DerivedFeature>(situations, { cases: casesPerSeed, sense: notesOnly }),
			kept: [
				{
					note: "every aggregate over every kind it takes",
					sketch: plantedAggregates,
					draws: "",
					reaches: aggregateKeys
				}
			],
			runs: casesPerSeed,
			shrink: { kind: "complete" },
			caseHang: Duration.minutes(2),
			perturb: "planner"
		},
		derivedCase
	)

export const suite = (name: string, seeds: ReadonlyArray<number>): void => {
	for (const seed of seeds) {
		/** The seed's number names the suite, and so its floor stream. */
		const label = `derived/seed-${seed.toString(16)}`
		layer(Substrate.layer, { excludeTestServices: true })(
			`${name} (seed ${seed.toString(16)})`,
			(it) => {
				it.effect(
					`${casesPerSeed} generated cases: every refreshed view equals its definition, in one commit, writing nothing it need not`,
					(ctx) => searched(ctx, explored(label)),
					600_000
				)
			}
		)
	}
}
