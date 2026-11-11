import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { type Situations, unreachedOf } from "@grizzle/testing/features"
import { Array as Arr, Effect } from "effect"
import {
	type ChangeSetNote,
	changeSetKept,
	changeSetRefusals,
	changeSetRequired,
	changeSetServed,
	changeSetWitnesses
} from "#test/support/agreement/changesets.ts"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"

/**
 * The ChangeSet type/engine agreement (test/support/agreement/changesets.ts), one program the type batch checks
 * disarmed: every drawn ChangeSet, and its application through a role's Db, typechecks exactly when the engine builds,
 * compiles and binds it; a refusal's Refusal names the engine's reason; and an admitted ChangeSet's parameters,
 * writes, read-backs and level, and its application's channels, are the engine's, each asserted exactly.
 *
 * The floor's witnesses, the same in every run, a population aimed at each requirement, plant every fault
 * and reach every construct, every verdict and every Refusal of the write path, so the program is never vacuous on any
 * seed. Beside them every run draws the kept cases, each a case a run's own stream once drew failing, replayed by its
 * tape and checked to still draw what it was kept for.
 */
const required: Situations<ChangeSetNote> = [
	"admitted",
	"refused",
	...changeSetRefusals,
	...changeSetServed,
	...changeSetRequired
]

layer(NodeServices.layer, { excludeTestServices: true })(
	"the ChangeSet type/engine agreement",
	(it) => {
		it.effect(
			`over drawn ChangeSets and the floor's, the types admit exactly what the engine builds, compiles and binds, name its refusal, and infer its parameters, writes, read-backs and channels`,
			() =>
				Effect.gen(function* () {
					const { expected, actual } = yield* checked("changeset/agreement")
					assert.deepEqual(actual, expected)
				})
		)

		it("each kept case still draws what it was kept for", () => {
			for (const { kept, drawn } of changeSetKept()) {
				assert.deepEqual(
					Arr.filter(kept.reaches, (n) => !drawn.notes.has(n)),
					[],
					kept.note
				)
			}
		})

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
