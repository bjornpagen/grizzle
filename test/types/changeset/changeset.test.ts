import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { type Situations, unreachedOf } from "@grizzle/testing/features"
import { Array as Arr, Effect } from "effect"
import {
	type ChangeSetNote,
	changeSetCount,
	changeSetRefusals,
	changeSetRequired,
	changeSetWitnesses
} from "#test/support/agreement/changesets.ts"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/groups.ts"

/**
 * The ChangeSet type/engine agreement (test/support/agreement/changesets.ts), one program the type batch checks
 * disarmed: every drawn ChangeSet, and its application through a role's Db, typechecks exactly when the engine builds,
 * compiles and binds it; a refusal's Refusal names the engine's reason; and an admitted ChangeSet's parameters,
 * writes, read-backs and level, and its application's channels, are the engine's, each asserted exactly.
 *
 * The floor's witnesses, the same in every run, a population aimed at each requirement, plant every fault
 * and reach every construct, every verdict and every Refusal of the write path, so the program is never vacuous on any
 * seed.
 */
const required: Situations<ChangeSetNote> = [
	"admitted",
	"refused",
	...changeSetRefusals,
	...changeSetRequired
]

layer(NodeServices.layer, { excludeTestServices: true })(
	"the ChangeSet type/engine agreement",
	(it) => {
		it.effect(
			`over ${changeSetCount} drawn ChangeSets and the floor's, the types admit exactly what the engine builds, compiles and binds, name its refusal, and infer its parameters, writes, read-backs and channels`,
			() =>
				Effect.gen(function* () {
					const { expected, actual } = yield* checked("changeset/agreement")
					assert.deepEqual(actual, expected)
				})
		)

		it("the floor's witnesses plant every fault and reach every construct, both verdicts and every Refusal", () => {
			assert.deepEqual(
				unreachedOf(
					required,
					Arr.map(changeSetWitnesses(), (w) => w.tally)
				),
				[],
				"situations no floor witness reached"
			)
		})
	}
)
