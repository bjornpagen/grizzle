/**
 * The three-way write oracle (test/support/oracle/write): generated write runs, each a generated schema installed in
 * the case's own database and opened once as one Db, whose write cases compare db.apply, the conservative realization
 * and the brute-force add-wins result.
 *
 * A case is one write run (index.ts runWrite): its schema (schema.ts), whether its tables carry planner statistics, a
 * plan perturbation (../perturb.ts), how each case's second reading stores its facts (../gen/restorage.ts), one to
 * twelve write cases and, where the schema holds the planted group, the planted cases after them (harness.ts). The run
 * installs its schema, checks the installation's privileges, and runs its cases in order on one Db, so the Db's server
 * statements outlive each program: the in-case sequence is the system under test. Its swarm decisions are the case's
 * own draws, so they replay and shrink with it, a failing run shrinking its schema and dropping its cases down to the
 * one that fails.
 *
 * - Property: every generated write's outcome, counts, refusal and stored state agree three ways.
 * - Oracle: a second implementation, the brute-force add-wins transition, and a differential against the conservative
 *   realization.
 * - Situations: writeSituations (index.ts), each a witness case must reach.
 * - Case deadline: a whole write run a case, measured (oracle.fixtures.ts writeRunDeadline).
 * - Kills: the compiler and runtime bugs the old suites 0, 1 and 3 caught (their plants, now kills): a staged member
 *   slot's carrier taken from another slot of the same heading, a later stratum's removal no longer cancelling an
 *   earlier addition, a fact removed and re-added in one stratum left added, and two orderings of the scheduler.
 *
 * The four old suites were one property under four labels, each a floor stream of its own: the runner's own streams
 * and its budget replace them. Their two kept cases (suite 1's) drew their schemas' resolution mid-case, from tapes
 * the old engine recorded, so their values alone replay neither; each is dropped with the situations that pin its
 * regression: a parameter outside its field read after a stratum that breaks a key ("outcome refused at bind" under
 * "parameters bound" and "strata:3"), and a refused side judged under the draws its sequences record ("lagging
 * identical netted", "lagging differing" and "counts under the realization's draws").
 */
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { writeRunDeadline } from "#test/pg/write/oracle/oracle.fixtures.ts"
import { CurrentRestorage } from "#test/support/oracle/gen/restorage.ts"
import {
	isPerturbed,
	printPerturbation,
	CurrentPerturbation
} from "#test/support/oracle/perturb.ts"
import { CaseFailed, type WriteOracleFeature } from "#test/support/oracle/write/harness.ts"
import { perturbedRunGen, runWrite, writeSituations } from "#test/support/oracle/write/index.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Generated write runs agree three ways: db.apply, add-wins and the conservative realization. */
export const writeOracle = property.explore(perturbedRunGen, {
	needs: { substrate: Substrate.fresh },
	caseDeadline: writeRunDeadline,
	situations: writeSituations,
	check:
		({ substrate }, c: Case<WriteOracleFeature>) =>
		([w, perturbation, restorage]) =>
			Effect.provideServiceEffect(
				Effect.scoped(
					runWrite(w, c).pipe(
						Effect.provideService(CurrentPerturbation, perturbation),
						Effect.provideService(CurrentRestorage, restorage)
					)
				).pipe(
					Effect.mapError((e) =>
						isPerturbed(perturbation)
							? new CaseFailed({ report: `${e.report}\n${printPerturbation(perturbation)}` })
							: e
					)
				),
				Substrate,
				substrate
			),
	oracle: {
		kind: "second-implementation",
		name: "the brute-force add-wins transition and the conservative realization"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/write/program/slot-carriers.ts",
			original: "\t\tconst fill = fillOf(s)",
			replacement:
				"\t\tconst other = slotReaders(placed).find(\n\t\t\t(o) => o.first.slot !== s.first.slot && sameHeading(o.first, s.first)\n\t\t)\n\t\tconst fill = fillOf(other === undefined ? s : { ...s, first: { ...s.first, slot: other.first.slot } })",
			why: "A staged member slot's carrier is filled from another slot of the same heading (write/program/slot-carriers.ts), so every statement that reads the carrier reads that slot's facts: the optimized program's outcome or stored state leaves the conservative realization's."
		},
		{
			file: "packages/engine/src/runtime/write/net.ts",
			original: "\t\t\t\tadded.delete(identity)",
			replacement: "\t\t\t\tremoved.delete(identity)",
			why: 'A later stratum\'s removal no longer cancels an earlier stratum\'s addition of the same fact (runtime/write/net.ts netStrata), so a removal keeps the addition it should cancel across strata; the property fails on the planted arm "added then removed" ("expected no-change, got accepted").'
		},
		{
			file: "packages/engine/src/runtime/write/net.ts",
			original: "\t\tif (removed.delete(identity)) {\n\t\t\tadded.delete(identity)\n\t\t}",
			replacement: "\t\tremoved.delete(identity)",
			why: 'A fact a stratum both removes and adds identically stays added (runtime/write/net.ts stratumChange); the property fails on the outcome ("expected no-change, got accepted").'
		},
		{
			file: "packages/engine/src/write/frontend/schedule.ts",
			original: "\t\t\tif (removes(xa) && removes(ya)) {\n\t\t\t\tx.follows.add(y)\n\t\t\t}\n",
			replacement: "",
			why: "The scheduler no longer runs a referencing relation's removals before the referenced one's across an immediate foreign key, so a stratum the keys order in a cycle compiles where the oracle expects UnorderableStratum."
		},
		{
			file: "packages/engine/src/write/frontend/schedule.ts",
			original:
				'\tphaseOf(a.action) < phaseOf(b.action) &&\n\t!(a.meeting === "nowhere" && a.action.op === "delete" && !isGenerated(b.action))',
			replacement: "\tphaseOf(a.action) < phaseOf(b.action)",
			why: 'The scheduler runs a deletion where facts meet nowhere before every addition of its relation, so it refuses the planted arm "deletion meeting nowhere", which only that exception orders.'
		}
	]
})
