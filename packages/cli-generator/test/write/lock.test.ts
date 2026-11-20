/**
 * The run lock (write/lock.ts, design 3.6): claimants that race for one output directory's lock leave one holder and
 * refuse every other with RunLockHeld, a refused claimant never removing the holder's file; and however the holder's
 * scope ends, its registered temp siblings and its lock go with it while every file it did not register stays.
 *
 * Oracle: design 3.6's Run lock, which states each.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Effect } from "effect"
import {
	claimantSpace,
	expectedHeld,
	expectedRace,
	heldOf,
	holdFeaturesOf,
	type HoldFeature,
	holdSpace,
	raceFeatureOf,
	type RaceFeature,
	raceOf
} from "#test/write/lock.fixtures.ts"

/** Of the claimants racing for one lock, exactly one holds it and every other is refused, the holder's lock untouched. */
export const oneClaimantHolds = property.exhaust(claimantSpace, {
	box: "one, two and three claimants of one output directory at once",
	needs: { dir: Scratch.dir },
	situations: ["a lone claimant", "one claimant refused", "several claimants refused"],
	check:
		({ dir }, k: Case<RaceFeature>) =>
		(claimants) =>
			Effect.gen(function* () {
				k.note(raceFeatureOf(claimants))
				const scratch = yield* dir
				const { lockPath, race } = yield* raceOf(scratch, claimants)
				assert.deepEqual(
					race,
					expectedRace(lockPath, claimants),
					"one claimant holds and sees its lock, every other is refused naming it, and none remains"
				)
			}),
	oracle: {
		kind: "specification",
		name: "design 3.6's Run lock: one holder, every other claimant refused with RunLockHeld and the lock path"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/write/lock.ts",
			original: 'error.reason._tag === "AlreadyExists"',
			replacement: "false",
			why: "A claim refused because another run holds the lock reads as RunLockUnavailable, so the generator reports a broken directory where another run is writing; the property fails (TESTPOLICY2's census, mutant 0bd3827019)."
		},
		{
			file: "packages/cli-generator/src/write/lock.ts",
			original: '{ flag: "wx" }',
			replacement: '{ flag: "w" }',
			why: "The lock file is written whether or not it exists, so every claimant holds the lock at once; the property fails."
		},
		{
			file: "packages/cli-generator/src/write/lock.ts",
			original: "\t\tyield* Effect.acquireRelease(",
			replacement:
				"\t\tyield* Effect.addFinalizer(() => release)\n\t\tyield* Effect.acquireRelease(",
			why: "A claimant releases the lock whether or not it took it, so a refused claimant's scope removes the holder's file while the holder still holds it; the property fails."
		}
	]
})

/** However a holder's scope ends, its registered temp siblings and its lock go, and only they. */
export const scopeEndReleases = property.exhaust(holdSpace, {
	box: "a holder of up to two registered temp siblings beside one file it did not register, claimed while held or not, its scope succeeding, failing or interrupted",
	needs: { dir: Scratch.dir },
	situations: [
		"a scope that succeeds",
		"a scope that fails",
		"a scope that is interrupted",
		"a registered temp sibling",
		"a file the holder did not register",
		"a claim refused while held"
	],
	check:
		({ dir }, k: Case<HoldFeature>) =>
		(c) =>
			Effect.gen(function* () {
				k.noteAll(holdFeaturesOf(c))
				const scratch = yield* dir
				const held = yield* heldOf(scratch, c)
				assert.deepEqual(
					held,
					expectedHeld(c),
					"the scope ends as ended, a claim while held is refused, and only what the holder registered goes"
				)
			}),
	oracle: {
		kind: "specification",
		name: "design 3.6's Run lock: the scope removes the registered temp siblings and the lock on success, failure or interrupt"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/write/lock.ts",
			original: "yield* Effect.ignore(fs.remove(temp, { force: true }))",
			replacement: "yield* Effect.void",
			why: "A closed scope leaves its registered temp siblings behind, so a failed or interrupted run strews its output directory with them; the property fails."
		},
		{
			file: "packages/cli-generator/src/write/lock.ts",
			original: "yield* Effect.ignore(fs.remove(lockPath, { force: true }))",
			replacement: "yield* Effect.void",
			why: "A closed scope leaves its lock file, so every later run into the directory is refused as though another held it; the property fails."
		},
		{
			file: "packages/cli-generator/src/write/lock.ts",
			original: "Ref.update(temps, (all) => [...all, temp])",
			replacement: "Ref.update(temps, (all) => all)",
			why: "Registering a temp sibling records nothing, so the scope's close removes none of them; the property fails."
		}
	]
})
