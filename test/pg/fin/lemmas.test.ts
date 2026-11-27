/**
 * The fin lemmas through grizzle's own lowering, per direction, on PostgreSQL 19 (fin.md §5.2, §11): an ordered and
 * a counted family declared with grizzle's formers and installed by their first migration, written by a direct SQL
 * writer, the owner, and judged by the families model (test/support/families), PostgreSQL the judge of the law.
 *
 * - **The specification turned into a checker:** the families theorem (theorem.ts): every owner's rows indexed by
 *   exactly 0 … n − 1. PostgreSQL must commit a state exactly when it holds.
 * - **A second implementation:** the families model of each transaction (mutate.ts), each installed constraint read as
 *   the model's by its columns' roles (family.ts), checked at the moment grizzle's lowering checks it (the owner axis
 *   and the keys at each statement, the last slot at COMMIT, the closure at each statement when ordered and at COMMIT
 *   when counted). A refusal must be at the model's moment, by a constraint the model allows there, with its SQLSTATE
 *   and the family's law.
 *
 * **Per direction:** grizzle states both directions in one former, so each is judged by its drop, a kill of the
 * properties in grizzle's lowering (laws/model/plan.ts). F[g, i] ⊆ fin(O, n) is held by the owner axis into the owners
 * of a member, their count above 0, and by the successor ‹s› the predecessor and last axes pair: the member at n names
 * the one at n − 1 its predecessor, whose successor the last axis holds at n − 1 itself; "within dropped" drops the
 * pairing, which a row just past a positive count catches, a state the search of states requires, and "within dropped at an empty owner" the owner axis's guard,
 * which a row of an owner of count 0 catches. fin(O, n) ⊆ F[g, i] is the last axis and the closure; "covers dropped"
 * drops both foreign keys, which a gap below the count catches.
 *
 * Spaces: states of owners 0 and 1, each absent or of count 0 to 3, with at most three rows at slots 0 to 4, every
 * successor its slot's in its owner's count, written from no state (lemmas.fixtures.ts statesGen); and random programs
 * of the families model's
 * lawful, breaking and misordered mutations (mutate.ts programGen), each step one transaction judged against the model
 * over the state before it, which one transaction replacing the seat's rows writes first.
 *
 * Each transaction judged is checked as its COMMIT would check it and rolled back, or ends by a real COMMIT, as the
 * case draws its end on its tape (installed.ts endGen): each search requires both ends, and the search of states, which
 * meets refusals at commit, a refusal at commit through each, so the search itself shows a real COMMIT never decides
 * otherwise than the checked end.
 */
import { runProgram } from "@bjornpagen/testing/commands"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, Option, Result } from "effect"
import { Disagreed, familySeatIn, judgedFamily } from "#test/pg/fin/family.ts"
import { endGen, endedBy, refusedAtCommitBy } from "#test/pg/fin/installed.ts"
import {
	lemmaFamilies,
	lemmaOracle,
	type ProgramFeature,
	programs,
	programSituations,
	rowJustPastCount,
	rowOfEmptyOwner,
	settledOn,
	type StateFeature,
	statesGen,
	storedOfSketch,
	writeStatements
} from "#test/pg/fin/lemmas.fixtures.ts"
import { emptyStored } from "#test/pg/substrate/fin.ts"
import {
	type Form,
	type Judges,
	type MutationStatement,
	machineOf,
	realOf,
	run,
	settledOf
} from "#test/support/families/mutate.ts"
import { type Families, storedOf, theorem } from "#test/support/families/theorem.ts"
import { type SqlError } from "#test/support/pg.ts"
import { type TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Its search budget: the fewest cases a run spends at which every kill it declares is killed and every situation it
 * requires reached. A kill's trial runs the witnesses alone, its kept cases, its floor stream of ⌈runs / 4⌉ cases and its
 * steered phase while a situation is unreached, all fixed by the property's identity and its floor, so runs within one
 * floor draw the same witnesses, and a run adds `runs` rotating cases.
 *
 * @limitKind measured
 * @owner grizzle's test/pg/fin/lemmas.test.ts
 * @unit independent cases (runs) and steered cases
 * @scope one run of commitExactlyTheStatesOfTheBoxTheFamiliesTheoremHoldsOf
 * @evidence `~/.cache/grizzle/CULL-FIN-tools/measure.sh r<runs> <runs> 200 <files>` over test/pg/fin's counted,
 *   lemmas, fold, plans and counted-set at runs 1, 4, 8, 16 and 32, the steered cases capped at 200, each a
 *   `toolchain-test run` of the files that ran the kills of every property it passed; uncommitted logs
 *   ~/.cache/grizzle/CULL-FIN-tools/measure-r{1,4,8,16,32}.log
 * @observed 2026-11-23 03:50 to 04:26 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, load 200 to 520 from other lanes;
 *   PostgreSQL 19.0 (scripts/pg/pin.env) as the lane's in-memory family; Node 26.13.1; grizzle f87b2aaab with lane
 *   CULL-FIN's cull of test/pg/fin; TEST_SEED=2219874524
 * @workload the property with its two kills, within dropped and covers dropped
 * @result steered cases to reach every required situation: 64 at a floor of one case (runs 1, 4), 64 at two (runs 8), 16
 *   at four (runs 16), 16 at eight (runs 32); both kills killed at every budget, no failure
 * @decision a floor of four spends the fewest, 33 cases a run at runs 13, the fewest runs with that floor, against 66 at a
 *   floor of one (runs 1), 71 at two (runs 5) and 53 at eight (runs 29); the steered cap the 16 it needs. Floors of
 *   three, five, six and seven are unmeasured; the exhaustive box ran 14,300 cases (f1bf91a2f)
 * @revalidate a change of the property, its space, its situations or the code its cases run, which moves its witnesses;
 *   a red that reaches no situation (FeaturesUnreached) or a kill that survives
 */
const statesBudget = { runs: 13, steered: 16 } as const

/**
 * Commit exactly the drawn states the families theorem holds of, through grizzle's seat of each shape, each case on a
 * clone of its own of both; each direction's drop is a kill.
 */
export const commitExactlyTheStatesOfTheBoxTheFamiliesTheoremHoldsOf = property.explore(statesGen, {
	needs: {
		ordered: Substrate.fresh(lemmaFamilies.ordered),
		counted: Substrate.fresh(lemmaFamilies.counted)
	},
	situations: [
		"a case ended by COMMIT",
		"a case ended by SET CONSTRAINTS and ROLLBACK",
		"a case refused at a real COMMIT",
		"a case refused at its checked commit",
		"ordered committed",
		"ordered refused key",
		"ordered refused holding",
		"ordered refused last",
		"ordered refused closure",
		"counted committed",
		"counted refused key",
		"counted refused holding",
		"counted refused last",
		"a row just past a positive count",
		"a row of an owner of count 0"
	] satisfies ReadonlyArray<Reached<StateFeature>>,
	check:
		({ ordered, counted }, c: Case<StateFeature>) =>
		(sketch) =>
			Effect.scoped(
				Effect.gen(function* () {
					const end = c.draw(endGen)
					const takes = [
						["ordered", yield* ordered],
						["counted", yield* counted]
					] as const
					yield* Effect.forEach(
						takes,
						([shape, taken]) =>
							Effect.gen(function* () {
								const family = yield* familySeatIn(shape, taken, `lemma ${shape}`)
								const stored = storedOfSketch(sketch)
								if (rowJustPastCount(stored)) {
									c.note("a row just past a positive count")
								}
								if (rowOfEmptyOwner(stored)) {
									c.note("a row of an owner of count 0")
								}
								const statements = writeStatements(stored)
								const lawful = Result.isSuccess(theorem(stored))
								const j = yield* Effect.provideService(
									judgedFamily(
										family,
										{ kind: "empty" },
										statements,
										settledOn(family, emptyStored, statements),
										end
									),
									Substrate,
									taken.substrate
								)
								c.note(`${shape} ${j.verdict}`)
								c.note(endedBy(j.end))
								if (Option.exists(j.moment, (m) => m.kind === "commit")) {
									c.note(refusedAtCommitBy(j.end))
								}
								if (j.committed !== lawful) {
									return yield* new Disagreed({
										message: `${shape}: PostgreSQL ${j.verdict} a state whose theorem ${lawful ? "holds" : "fails"}: ${Formatter.format(sketch)}`
									})
								}
							}),
						{ concurrency: "unbounded", discard: true }
					)
				})
			),
	oracle: lemmaOracle,
	show: Formatter.format,
	budget: statesBudget,
	kept: [],
	kills: [
		{
			file: "packages/engine/src/laws/model/plan.ts",
			original:
				"\t\tconst successors = appendNonEmpty(familyKeyColumns, next)\n\t\tconst predecessorBase = appendNonEmpty(successorKey, index)\n\t\tconst lastSlots = appendNonEmpty(lastBase, lastPred)",
			replacement:
				"\t\tconst successors = familyKeyColumns\n\t\tconst predecessorBase = successorKey\n\t\tconst lastSlots = lastBase",
			why: "Within dropped: the predecessor and last axes reference the slots alone, no successor beside them, so a row at the slot past its owner's last names that last member its predecessor and commits, and a state the families theorem fails is committed."
		},
		{
			file: "packages/engine/src/laws/model/plan.ts",
			original: "\t\t\t\tselection: this.#holding()",
			replacement: "\t\t\t\tselection: { conjuncts: [] }",
			why: "Within dropped at an empty owner: the owner axis references every owner's key, its count above 0 or not, so a row of an owner of count 0 at slot 0, which no closure and no last slot reaches, commits, and a state the families theorem fails is committed."
		},
		{
			file: "packages/engine/src/laws/model/plan.ts",
			original:
				"\t\t\taxes.predecessor.foreignKey,\n\t\t\t...axes.last.natives,\n\t\t\taxes.last.foreignKey\n",
			replacement: "\t\t\t...axes.last.natives\n",
			why: "Covers dropped: a family installs neither its last axis's nor its closure's foreign key, so a gap below the count commits, and a state the families theorem fails is committed."
		}
	]
})

/**
 * Refuse exactly the steps of random programs of family mutations the model refuses, where it refuses them, and commit
 * the rest to the model's families, each case on a clone of its own of its program's shape.
 *
 * Its pre-conversion budget: runs 200, coverage cases 400 (test/pg/fin/lemmas.test.ts at edabdcc5f).
 */
export const refuseExactlyTheStepsOfRandomProgramsTheModelRefusesAndCommitTheRest =
	property.explore(programs, {
		needs: {
			ordered: Substrate.fresh(lemmaFamilies.ordered),
			counted: Substrate.fresh(lemmaFamilies.counted)
		},
		situations: programSituations,
		check: (families, c: Case<ProgramFeature>) => (p) =>
			Effect.scoped(
				Effect.gen(function* () {
					const taken = yield* families[p.shape]
					const f = yield* familySeatIn(p.shape, taken, `programs ${p.shape}`)
					yield* Effect.provideService(
						Effect.gen(function* () {
							const step = (
								form: Form,
								statements: ReadonlyArray<MutationStatement>,
								before: Families
							): Effect.Effect<void, SqlError | TransactionRolledBack | Disagreed> =>
								Effect.gen(function* () {
									const j = yield* judgedFamily(
										f,
										{ kind: "replaced", before: storedOf(before) },
										statements,
										settledOf(run(p.shape, before, statements)),
										c.draw(endGen)
									)
									c.note(`${p.shape} ${form} ${j.committed ? "committed" : "refused"}`)
									c.note(endedBy(j.end))
									if (Option.exists(j.moment, (m) => m.kind === "commit")) {
										c.note(refusedAtCommitBy(j.end))
									}
								})
							const judges: Judges<SqlError | TransactionRolledBack | Disagreed, never> = {
								lawful: (form, m, before) => step(form, m.statements, before),
								breaking: (form, m, before) => step(form, m.statements, before),
								misordered: (m, before) => step("misorder", m.statements, before)
							}
							yield* runProgram(machineOf(p.shape, p.families, p.forms), realOf(judges), p.steps)
						}),
						Substrate,
						taken.substrate
					)
				})
			),
		oracle: lemmaOracle,
		show: Formatter.format,
		budget: { runs: 200, steered: 400 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					"\t\tconst successors = appendNonEmpty(familyKeyColumns, next)\n\t\tconst predecessorBase = appendNonEmpty(successorKey, index)\n\t\tconst lastSlots = appendNonEmpty(lastBase, lastPred)",
				replacement:
					"\t\tconst successors = familyKeyColumns\n\t\tconst predecessorBase = successorKey\n\t\tconst lastSlots = lastBase",
				why: "Within dropped: the predecessor and last axes reference the slots alone, no successor beside them, so a row inserted past its owner's last, or a count lowered under a row it leaves past the last, commits where the model refuses it."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\t\t\t\tselection: this.#holding()",
				replacement: "\t\t\t\tselection: { conjuncts: [] }",
				why: "Within dropped at an empty owner: the owner axis references every owner's key, its count above 0 or not, so a count lowered to 0 over its one row commits, and a state the families theorem fails is committed."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					"\t\t\taxes.predecessor.foreignKey,\n\t\t\t...axes.last.natives,\n\t\t\taxes.last.foreignKey\n",
				replacement: "\t\t\t...axes.last.natives\n",
				why: "Covers dropped: a family installs neither its last axis's nor its closure's foreign key, so a gap below the count commits, and a state the families theorem fails is committed."
			}
		]
	})
