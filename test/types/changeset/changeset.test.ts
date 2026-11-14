import { type Situations, unreachedOf } from "@bjornpagen/testing/features"
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
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
 *
 * Plant (~/.cache/grizzle-release/BR14/plants): changeset-writable-world.patch lets a ChangeSet write a world relation
 * its role's write list does not name. Plant (~/.cache/grizzle-release/ONCETYPES/plants): once-facts-unchecked.patch
 * checks a served call's facts against their declared record alone (live/program.ts InputCheck), as the once/watch
 * cutover did, so a call naming a relation or an op its member holds no array of, a fact with a field its relation
 * lacks, or two literal facts at one key with different values, is admitted. Plants
 * (~/.cache/grizzle-release/TYPEREGRESS/plants): b-call-skips-conflict.patch judges an application's call by its
 * ChangeSet's verdict alone, not by callVerdictOf, so a call whose facts, gathered across a union's operands, hold two
 * literal facts at one key with different values is expected admitted (TEST_SEED=1678781499); no-claims-unknown.patch
 * has a fact whose key no literal types claim unknown (types/schema/relation.ts NoClaims), which collapses its array's
 * claims, so a key conflict beside such a fact is admitted, the floor's witness of "a key conflict beside a fact no
 * literal keys" refused by the engine.
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
