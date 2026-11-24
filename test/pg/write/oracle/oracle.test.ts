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
 *   slot's carrier taken from another slot of the same heading, a removal that weighs as an addition and a cancelled
 *   fact kept in the Z-set (core/zset.ts), which leave a later stratum's removal of an earlier addition, or a fact
 *   removed and re-added in one stratum, added, and two orderings of the scheduler; and
 *   lane CATCH's kill from the mutation tester's old oracle subset: the checker never finding the match of a bind map
 *   whose variables are all bound.
 *
 * The four old suites were one property under four labels, each a floor stream of its own: the runner's own streams
 * and its budget replace them. Their two kept cases (suite 1's) drew their schemas' resolution mid-case, from tapes
 * the old engine recorded, so their values alone replay neither; each is dropped with the situations that pin its
 * regression: a parameter outside its field read after a stratum that breaks a key ("outcome refused at bind" under
 * "parameters bound" and "strata:3"), and a refused side judged under the draws its sequences record ("lagging
 * identical netted", "lagging differing" and "counts under the realization's draws").
 */
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
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
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** Generated write runs agree three ways: db.apply, add-wins and the conservative realization. */
export const writeOracle = property.explore(perturbedRunGen, {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
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
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "second-implementation",
		name: "the brute-force add-wins transition and the conservative realization"
	},
	kept: [
		{
			token: ReplayToken(
				"test/pg/write/oracle/oracle.test.ts#writeOracle:1fffffffffffffffff.d:1.2.cn4.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.3.0.0.0.3.2.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.1.0.0.1.0.1.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
			),
			reason:
				"a read-back of G0R1's removed facts attaching G0R0, both deleted in one stratum their containment orders, runs after the writes over its delta carried out of G0R1's deletion, whose carrier's fill is a data-modifying CTE no part of the statement reads, with no RETURNING",
			since: "2026-11-24"
		}
	],
	kills: [
		{
			file: "packages/engine/src/physical/ddl/roles.ts",
			original: '\t\t\treturn ["SELECT", "INSERT"]',
			replacement: '\t\t\treturn ["SELECT", "INSERT", "DELETE"]',
			why: "A writer of a closed relation, which its insert list names (wholeWritesOf), holds DELETE on its table again (physical/ddl/roles.ts entryPrivileges): the run's privilege check, a closed table's DELETE a problem, fails."
		},
		{
			file: "packages/engine/src/write/program/slot-carriers.ts",
			original: "\t\tconst fill = fillOf(s)",
			replacement:
				"\t\tconst other = slotReaders(placed).find(\n\t\t\t(o) => o.first.slot !== s.first.slot && sameHeading(o.first, s.first)\n\t\t)\n\t\tconst fill = fillOf(other === undefined ? s : { ...s, first: { ...s.first, slot: other.first.slot } })",
			why: "A staged member slot's carrier is filled from another slot of the same heading (write/program/slot-carriers.ts), so every statement that reads the carrier reads that slot's facts: the optimized program's outcome or stored state leaves the conservative realization's, as the planted arm \"twin replaces\" stages two carriers of one heading."
		},
		{
			file: "packages/engine/src/core/zset.ts",
			original: "export const weightOf = { added: 1, removed: -1 } as const",
			replacement: "export const weightOf = { added: 1, removed: 1 } as const",
			why: 'A removal weighs as an addition (core/zset.ts weightOf), so a later stratum\'s removal no longer cancels an earlier stratum\'s addition of the same fact, nor a stratum\'s removal its identical addition; the property fails on the planted arm "added then removed" ("expected no-change, got accepted").'
		},
		{
			file: "packages/engine/src/core/zset.ts",
			original: "\t\t\tnet.delete(key)",
			replacement: "\t\t\tnet.set(key, { weight, value: next.value })",
			why: 'A fact whose weights sum to 0 stays in the Z-set (core/zset.ts addInto), so a fact a stratum both removes and adds identically, or one a later stratum removes, is counted under its tag; the property fails on the outcome ("expected no-change, got accepted").'
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
				'\tphaseOf(a.action) < phaseOf(b.action) && !(a.meeting === "nowhere" && a.action.op === "delete")',
			replacement: "\tphaseOf(a.action) < phaseOf(b.action)",
			why: 'The scheduler runs a deletion where facts meet nowhere before every addition of its relation, so it refuses the planted arm "deletion meeting nowhere", which only that exception orders.'
		},
		{
			file: "packages/engine/src/check/checker.ts",
			original: "\t\t\tconst found = pending.find((q) => waiting(q.match).length === 0)",
			replacement: "\t\t\tconst found = pending.find((q) => waiting(q.match).length === (-1))",
			why: "Operator mutant (bound) at packages/engine/src/check/checker.ts:2568 in <module>: `0` becomes `(-1)`; the property fails (lane CATCH, grizzle 0baff5d6, against the mutation tester's oracle subset scripts/dev/mutate/oracle/writes.test.ts, which this property replaces)."
		},
		{
			file: "packages/grizzle/src/adapter/apply/run.ts",
			original:
				"\t\t\t\treturn Effect.succeed(detail === undefined ? unreproduced : unmatchedKey(unmatched, detail))",
			replacement: "\t\t\t\treturn Effect.succeed(unreproduced)",
			why: "The diagnosis of a refusal at COMMIT reads no row: a deferred containment the final state breaks is refused at COMMIT with an unreproduced witness, where the expectation is the primary key of a source fact naming no target fact."
		},
		{
			file: "packages/engine/src/write/unmatched.ts",
			original: "\t\t\t\t\tunmatched\n",
			replacement: "\t\t\t\t\tlit.bool(true)\n",
			why: "A deferred foreign key's witness query names the least row of its table whatever it references: a deferred containment's refusal at COMMIT is witnessed by the least source fact, one naming a target fact where the source holds such a fact below every unmatched one, where the expectation is a source fact naming none."
		}
	]
})
