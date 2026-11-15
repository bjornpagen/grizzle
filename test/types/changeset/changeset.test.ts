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
 * @plant test/plants/types/changeset/once-facts-unchecked.patch A served call's facts are admitted wherever their
 * declared record admits them (live/program.ts InputCheck and InputCheckOf), as the once/watch cutover did, so a call
 * naming a relation or an op its member holds no array of, a fact with a field its relation lacks, or two literal facts
 * at one key with different values, is admitted; the agreement's program fails.
 * @plant test/plants/types/changeset/b-call-skips-conflict.patch The oracle judges an application's call by its
 * ChangeSet's verdict alone, not by callVerdictOf, so a call whose facts, gathered across a union's operands, hold two
 * literal facts at one key with different values is expected admitted; the floor's witness of "a key conflict at the
 * application's call" reaches it on every seed, and the agreement's program fails.
 * @plant test/plants/types/changeset/no-claims-unknown.patch A fact whose key no literal types claims unknown
 * (types/schema/relation.ts NoClaims), which collapses its array's claims, so a key conflict beside such a fact is
 * admitted, the floor's witness of "a key conflict beside a fact no literal keys" refused by the engine; the
 * agreement's program fails.
 * @plant test/plants/types/changeset/faulted-owner-put.patch A case that plants a fault may put a mutable family owner
 * (Cart, Bin) beside a whole delete of it, which the types refuse at the ChangeSet where the oracle places the fault's
 * refusal at the workload; the kept case reaches it on every seed, and the agreement's program fails.
 * @plant test/plants/types/changeset/owner-delete-clerkly.patch The oracle reads a delete of a family's owner as
 * writing the owner alone, not its members, so its kept case's tape draws the reader; "each kept case still draws what
 * it was kept for" fails.
 * @plant test/plants/types/changeset/types-delete-after-put-admitted.patch delete drops PutBesideDoomed, so a whole
 * delete after a put in one stratum is admitted; the agreement's program fails.
 * @plant test/plants/types/changeset/types-put-beside-doomed-admitted.patch A put beside a whole delete of its row in
 * one stratum is admitted (DoomedRefusal never refuses); the agreement's program fails.
 * @plant test/plants/types/changeset/types-union-doomed-admitted.patch A union's UnionDoomed never refuses, so one
 * operand's put of a row the other removes whole in an aligned stratum is admitted; the agreement's program fails.
 * @plant test/plants/types/changeset/types-delete-keyed.patch A delete's facts are judged at the primary key, so two
 * facts at one key that differ elsewhere, which a delete admits, are refused; the agreement's program fails.
 * @plant test/plants/types/changeset/types-delete-row-written.patch A tree's delete takes the whole written row
 * (DeletedRow), not its root fields alone, so a tree deleted by its root is refused; the agreement's program fails.
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
