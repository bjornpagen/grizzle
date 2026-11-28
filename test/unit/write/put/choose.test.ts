/**
 * Each put's statement (write/put/choose.ts choosePutTargets), held to the rules its header states, restated over the
 * box's names: a mutable R(b, c, d) keyed by (b, c), beside one more unique object or none, and a closed S(b, c, e) of
 * R's key, put by each form a ChangeSet writes it in, in one stratum or after an insert in an earlier one.
 *
 * - A unique object reading a field outside the primary key, key(d), splits every put that may move one of its values
 *   (uniqueSplit): an UPDATE checks it at each row, so a statement moving a value between facts would raise 23505 on a
 *   lawful final state, and so the rows whose d differs take the pair while the rest update in place; a put of R's own
 *   facts as they stand, its d read from the fact at its key, moves none and is an UPDATE ... FROM (existingKeys).
 * - A put of a relation parameter beside the deletion `R where d = $scope and (b, c) not in the parameter`, a scoped
 *   replace, is the pair (unproved), beside its deletion's own statement, alone or beside an insert into R: no target
 *   absorbs the deletion, which reads the scope by its key where one MERGE read R whole.
 * - A put of R's own facts, each key a stored fact's, is an UPDATE ... FROM (existingKeys) when the stratum deletes
 *   nothing of R, and the pair (unproved) beside a deletion, whose key the UPDATE would leave no row to update. So is a
 *   put of R's fact at a parameter key joined with S's, which the navigation reads a step a relation (ir/rel.ts Step):
 *   R's step reading R at the key its region fixes to the parameters, under a filter fixing R's key to them with each
 *   row found at the parameters, or at the columns S's step bound before it, the key each row carries being a stored
 *   fact of R's (write/put/proof.ts existingKeysProofOver).
 * - An enumerated put is an ON CONFLICT DO UPDATE (enumerated), unless another stratum writes R too: the netting of its
 *   strata needs every fact the put displaces, whose old version ON CONFLICT DO UPDATE never returns, so the put is the
 *   pair (netting).
 *
 * And what its statement reads its input as: an enumerated put's facts are distinct and unique at R's key by the codec's
 * normalization, and a put of R's own facts is unique at R's key by the key its member proves, so neither statement
 * deduplicates its input or checks it for two facts of one key.
 *
 * Features: each statement and reason a put lowers to.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { inputGuarantees } from "#compiler/write/insert/input.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"
import { descOf } from "#test/support/unit/write/changeset/fixtures.ts"
import {
	caseGen,
	changeSetOf,
	type Choice,
	type ChoiceFeature,
	expectedOf,
	featureOf,
	ownFactsAlone,
	schemaOf
} from "#test/unit/write/put/choose.fixtures.ts"

/** A put's statement is the one its relation's unique objects and its stratum's other actions on the relation admit, by the rules its header states. */
export const aPutsStatementIsTheOneItsRelationsUniqueObjectsAndItsStratumsOtherActionsOnTheRelationAdmitByTheRulesItsHeaderStates =
	property.exhaust(finite(caseGen), {
		needs: {},
		situations: [
			"uniqueSplit (candidateKey)",
			"deleteThenInsert (unproved)",
			"deleteThenInsert (netting)",
			"updateFrom (existingKeys)",
			"onConflictDoUpdate (enumerated)"
		] satisfies ReadonlyArray<Reached<ChoiceFeature>>,
		check:
			(_, c: Case<ChoiceFeature>) =>
			([uniques, form]) =>
				Effect.sync(() => {
					const s = schemaOf(uniques)
					const compiled = succeeded(
						compileWrite(
							checking(s),
							descOf(changeSetOf(s, form)),
							realityWrite(succeeded(testArtifacts(s, testCompile)))
						),
						"the write"
					)
					const first = defined(compiled.choices[0], "R's first put's choice")
					const written = defined(
						Arr.findFirst(
							Arr.flatMap(compiled.plan.steps, (step) =>
								step.kind === "write" ? [step] : step.kind === "single" ? step.writes : []
							),
							(w) => w.action.stratum === first.stratum && w.action.index === first.action
						).pipe(Option.getOrUndefined),
						"R's first put's statement"
					)
					const guarantees = inputGuarantees(written.input)
					if (form === "enumerated") {
						assert.ok(guarantees.distinct, "an enumerated input is distinct")
						assert.equal(
							guarantees.keyUnique.kind,
							"normalized",
							"an enumerated input is key-unique"
						)
					}
					if (ownFactsAlone(form)) {
						assert.equal(guarantees.keyUnique.kind, "proved", "R's own facts are unique at R's key")
					}
					const expected = expectedOf(uniques, form)
					assert.deepEqual<Choice>(
						{ target: first.target, reason: first.reason },
						expected,
						`${form} beside ${uniques}`
					)
					c.note(featureOf(expected))
				}),
		oracle: {
			kind: "specification",
			name: "choosePutTargets' rules, restated over the box"
		},
		box: "a mutable R(b, c, d) keyed by (b, c), beside no other unique object, key(c), a key over a selected (b, c) or key(d), put from a relation parameter beside the scoped deletion of what it lacks, alone or beside an insert, from its own facts, alone or beside a deletion, from its fact at a parameter key joined with S's, read in its step at the key its region fixes, under a filter fixing it or after S's step, or enumerated, alone or after an insert in an earlier stratum",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/put/choose.ts",
				original:
					'\t\t\t\t\t\treturn primary.kind === "key"\n\t\t\t\t\t\t\t? chosen({ ...place, target: "uniqueSplit", reason: "candidateKey", inPlace, moved })\n\t\t\t\t\t\t\t: pair("candidateKey")\n',
				replacement: '\t\t\t\t\t\treturn pair("candidateKey")\n',
				why: "Every row of a put that may move a value of a unique object outside the key routed through the pair (candidateKey), where only the rows whose value differs need it: every unchanged row deleted and inserted again, a dead tuple and a new entry in every index, and every deferred reference to it checked again."
			},
			{
				file: "packages/engine/src/write/put/choose.ts",
				original: "\t\t\t\t\t\t\t!existingKeysProof(reads.node, relation, kept))\n",
				replacement: "\t\t\t\t\t\t\t!existingKeysProof(reads.node, relation, []))\n",
				why: "The existing-keys proof asked of the key alone: a put of R's own facts with d set to 1 is an UPDATE ... FROM, which can move a value of key(d) from one fact to another and raise 23505 on a lawful final state."
			},
			{
				file: "packages/engine/src/write/put/choose.ts",
				original:
					'\t\t\t\t\t\t: severalStrata(action.relation)\n\t\t\t\t\t\t\t? "netting"\n\t\t\t\t\t\t\t: undefined',
				replacement: "\t\t\t\t\t\t: undefined",
				why: "A put of a relation another stratum writes is no longer the pair for its netting (write/put/choose.ts noOldVersion)."
			},
			{
				file: "packages/engine/src/write/put/proof.ts",
				original: '\t\t\tcase "Step":\n\t\t\t\treturn yield question(node.input, keyed)\n',
				replacement: '\t\t\tcase "Step":\n\t\t\t\treturn false\n',
				why: "A navigation's step is opaque to the existing-keys proof: a put of R's fact at a parameter key joined with S's is the pair (unproved)."
			},
			{
				file: "packages/engine/src/write/put/proof.ts",
				original: "\t\tconst keyed = asFixedColumns(node, q.values, fixed)\n",
				replacement: "\t\tconst keyed = q.values\n",
				why: "A column the physical analysis fixes to a parameter stands for nothing in the proof: a put of R's fact under a filter fixing its key to the parameters is the pair (unproved)."
			},
			{
				file: "packages/engine/src/write/put/proof.ts",
				original: '\t\t\t\t\t\touter: { kind: "outer", node: node.id, column: v.name }\n',
				replacement: '\t\t\t\t\t\touter: { kind: "outer", node: node.id, column: "" }\n',
				why: "A step that reads R at the columns S's step bound names no column of the region the proof asks of: a put of R's fact after S's step is the pair (unproved)."
			}
		]
	})
