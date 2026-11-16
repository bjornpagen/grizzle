/**
 * Roster migrations, drafted with no database: every program of at most six commands (grow, remove, re-add, reorder,
 * add a set, regenerate, change the closed rows) over a roster of at most four handles, exhausted as its steps: every
 * state a program of at most five steps reaches, each with every step it can take next. That box holds every step of
 * every such program, since what the real system stands at after a step is a function of the model's state alone: a
 * draft's snapshot is its target's (the schema the state declares, compiled under the codes the state holds), which
 * each step checks against the state, and the step's draft is a function of that snapshot and the next state's.
 *
 * The oracle is a second implementation of a roster change's draft: the model keeps its own history of the roster's
 * codes (a handle keeps its code, a removed one leaves a hole, a new or re-added one takes the next code) and predicts,
 * slot by slot, every statement a step drafts for the roster: its new names constant (and a set's live constant) in
 * Setup, its domain's CHECK dropped and added NOT VALID in Structure and validated in Validate, a set's bits domain,
 * bit(n) with n the codes rounded up to whole hex digits, re-pointed the same way when its width stands and replaced
 * by a new one of the new width when the roster grows past a whole digit, the set column converted by its cast to
 * bit(n′), and the old functions and domain dropped in Publish. The names the
 * model predicts are minted through the naming door from its own codes. A reorder is refused before anything is
 * drafted, by D1's refusal; a regenerate drafts nothing and leaves the snapshot as it was; a change of the closed
 * relation's rows drafts its law's check first in Setup, and a change whose rows break the law is refused, which a
 * second judge, the reference evaluator of the law's violation query, decides, and the field PostgreSQL generates from
 * the closed relation's rows (C.at) takes its new expression (SET EXPRESSION). The closed relation's own constants are
 * held to the one rule for content-addressed objects: every constant the target adds is created in Setup and every one
 * it removes dropped in Publish. The publish.comments and publish.defaults slots are outside the model's contract.
 *
 * Every accepted step is checked against the state the model claims (doctrine rule 11): the new snapshot's codebook is
 * the model's codes, read from the snapshot and from its written text read back (the round trip), and its fingerprint
 * is a fresh installation's of the same declaration exactly when the roster has no hole. Each step drafts from the
 * snapshot its previous step wrote, read back from its text as `grizzle generate` reads snapshot.json, so a change of
 * the closed rows meets the snapshot an earlier change wrote: among them a closed relation with an open payload, whose
 * cells stay one constant while the values its pack names change.
 */

import { runProgram } from "@bjornpagen/testing/commands"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	boxGen,
	FEATURES,
	type Feature,
	machine,
	realOf,
	transitions
} from "#test/unit/deploy/rosters.fixtures.ts"

/** Roster migrations draft exactly the model's statements, slot by slot, for every program of at most six roster commands over four handles, refusing a reorder and a broken closed law. */
export const rosterMigrationsDraftExactlyTheModelsStatementsSlotBySlotForEveryProgramOfAtMostSixRosterCommandsOverFourHandlesRefusingAReorderAndABrokenClosedLaw =
	property.exhaust(finite(boxGen), {
		box: "every state a program of at most five commands (grow, remove, re-add, reorder, add a set, regenerate, change the closed rows) reaches over a roster of at most four handles, from a roster of one handle with no set, with every step it can take next",
		needs: { transitions },
		situations: FEATURES satisfies ReadonlyArray<Reached<Feature>>,
		check: (resources, c: Case<Feature>) => (steps) =>
			Effect.gen(function* () {
				const table = yield* resources.transitions
				const ran = yield* runProgram(machine, realOf(table), steps)
				for (const verdict of ran.verdicts) {
					c.note(verdict)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "a model of the roster's codes predicting each step's statements by slot, with the reference evaluator judging the closed law"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/codes.ts",
				original: "\t\tconst before = continued.get(roster.closed) ?? []",
				replacement: "\t\tconst before = continued.get(roster.closed) === undefined ? [] : []",
				why: "Every roster's codes are drafted afresh, none continued, so a handle past a hole takes another code; the draft is refused as a defect by generate's continuity check (deploy/render/generate.ts discontinuedRoster)."
			}
		]
	})
