/**
 * The fin lemmas through grizzle's own lowering, per direction, on PostgreSQL 19rc2 (fin.md §5.2, §11): an ordered and
 * a counted family declared with grizzle's formers and installed by their first migration, written by a direct SQL
 * writer, the owner, and judged by the families model (test/support/families), PostgreSQL the judge of the law.
 *
 * - **The specification turned into a checker:** the families theorem (theorem.ts): every owner's rows indexed by
 *   exactly 0 … n − 1. PostgreSQL must commit a state exactly when it holds.
 * - **A second implementation:** the families model of each transaction (mutate.ts), each installed constraint read as
 *   the model's by its columns' roles (family.ts), checked at the moment the RFC's lowering checks it (the owner axis
 *   and the keys at each statement, the last slot at COMMIT, the closure at each statement when ordered and at COMMIT
 *   when counted). A refusal must be at the model's moment, by a constraint the model allows there, with its SQLSTATE
 *   and the family's law.
 *
 * **Per direction:** grizzle states both directions in one former, so each is judged by its drop, a kill of the
 * properties in grizzle's lowering (laws/model/plan.ts): "within dropped" (the bound, F[g, i] ⊆ fin(O, n)'s CHECK) and
 * "covers dropped" (the last axis and the closure, fin(O, n) ⊆ F[g, i]'s foreign keys), which a row beyond the count and
 * a gap below it catch.
 *
 * Boxes: every state of owners 0 and 1, each absent or of count 0 to 3, with at most three rows at slots 0 to 4, every
 * copy its owner's count, written from no state (doctrine rule 9); and random programs of the families model's lawful,
 * breaking and misordered mutations (mutate.ts programGen), each step one transaction judged against the model over the
 * state before it, which one transaction replacing the seat's rows writes first.
 *
 * Each transaction judged is checked as its COMMIT would check it and rolled back, or ends by a real COMMIT, as the
 * case draws its end on its tape (installed.ts endGen): each box requires both ends, and the box of states, which meets refusals at commit,
 * a refusal at commit through each, so the search itself shows a real COMMIT never decides otherwise than the checked
 * end.
 */
import { runProgram } from "@bjornpagen/testing/commands"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, Option, Result } from "effect"
import { Disagreed, familySeatIn, judgedFamily } from "#test/pg/fin/family.ts"
import { endGen, endedBy, refusedAtCommitBy } from "#test/pg/fin/installed.ts"
import {
	lemmaFamilies,
	lemmaOracle,
	lemmaSeatOf,
	type ProgramFeature,
	programs,
	programSituations,
	settledOn,
	type StateFeature,
	stateGen,
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
 * Commit exactly the states of the box the families theorem holds of, through grizzle's seat of each shape, each case on
 * the worker's seats of both; each direction's drop is a kill.
 *
 * Its pre-conversion budget: the box (test/pg/fin/lemmas.test.ts at edabdcc5f).
 */
export const commitExactlyTheStatesOfTheBoxTheFamiliesTheoremHoldsOf = property.exhaust(
	finite(stateGen),
	{
		needs: {
			ordered: Substrate.seat(lemmaFamilies.ordered),
			counted: Substrate.seat(lemmaFamilies.counted)
		},
		situations: [
			"a case ended by COMMIT",
			"a case ended by SET CONSTRAINTS and ROLLBACK",
			"a case refused at a real COMMIT",
			"a case refused at its checked commit",
			"ordered committed",
			"ordered refused key",
			"ordered refused bound",
			"ordered refused copy",
			"ordered refused last",
			"ordered refused closure",
			"counted committed",
			"counted refused key",
			"counted refused bound",
			"counted refused copy",
			"counted refused last"
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
									const seat = yield* Effect.provideService(
										lemmaSeatOf(family),
										Substrate,
										taken.substrate
									)
									const stored = storedOfSketch(sketch)
									const statements = writeStatements(stored)
									const lawful = Result.isSuccess(theorem(stored))
									/** Uninterruptible: a seat's transaction and its clearing run whole. */
									const j = yield* Effect.uninterruptible(
										Effect.provideService(
											judgedFamily(
												seat.family,
												{ kind: "empty" },
												statements,
												settledOn(seat, emptyStored, statements),
												end
											),
											Substrate,
											taken.substrate
										)
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
		box: "every state of owners 0 and 1, each absent or of count 0 to 3, with at most three rows over slots 0 to 4 of either owner, every copy its owner's count, written from no state in one transaction, each case ended by a real COMMIT and by the checked end",
		show: Formatter.format,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					'\t\t\town.add(\n\t\t\t\tindex.kind === "field"\n\t\t\t\t\t? cmp("lt", i, n)\n\t\t\t\t\t: and([cmp("ge", i, naturalLiteral(0n)), cmp("lt", i, n)])\n\t\t\t)',
				replacement: '\t\t\town.add(cmp("ge", i, naturalLiteral(0n)))',
				why: "Within dropped: a family installs no bound CHECK (i < ‹n›), so a row at a slot beyond its owner's count commits, and a state the families theorem fails is committed."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					'\t\t\t...(["owner", "predecessor", "last"] as const).flatMap((a) => [\n\t\t\t\t...axes[a].natives,\n\t\t\t\taxes[a].foreignKey\n\t\t\t])',
				replacement:
					'\t\t\t...(["owner", "predecessor", "last"] as const).flatMap((a) =>\n\t\t\t\ta === "owner" ? [...axes[a].natives, axes[a].foreignKey] : axes[a].natives\n\t\t\t)',
				why: "Covers dropped: a family installs neither its last axis's nor its closure's foreign key, so a gap below the count commits, and a state the families theorem fails is committed."
			}
		]
	}
)

/**
 * Refuse exactly the steps of random programs of family mutations the model refuses, where it refuses them, and commit
 * the rest to the model's families, each case on the worker's seat of its program's shape.
 *
 * Its pre-conversion budget: runs 200, coverage cases 400 (test/pg/fin/lemmas.test.ts at edabdcc5f).
 */
export const refuseExactlyTheStepsOfRandomProgramsTheModelRefusesAndCommitTheRest =
	property.explore(programs, {
		needs: {
			ordered: Substrate.seat(lemmaFamilies.ordered),
			counted: Substrate.seat(lemmaFamilies.counted)
		},
		situations: programSituations,
		check: (seats, c: Case<ProgramFeature>) => (p) =>
			Effect.scoped(
				Effect.gen(function* () {
					const taken = yield* seats[p.shape]
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
					'\t\t\town.add(\n\t\t\t\tindex.kind === "field"\n\t\t\t\t\t? cmp("lt", i, n)\n\t\t\t\t\t: and([cmp("ge", i, naturalLiteral(0n)), cmp("lt", i, n)])\n\t\t\t)',
				replacement: '\t\t\town.add(cmp("ge", i, naturalLiteral(0n)))',
				why: "Within dropped: a family installs no bound CHECK (i < ‹n›), so a row at a slot beyond its owner's count commits, and a state the families theorem fails is committed."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					'\t\t\t...(["owner", "predecessor", "last"] as const).flatMap((a) => [\n\t\t\t\t...axes[a].natives,\n\t\t\t\taxes[a].foreignKey\n\t\t\t])',
				replacement:
					'\t\t\t...(["owner", "predecessor", "last"] as const).flatMap((a) =>\n\t\t\t\ta === "owner" ? [...axes[a].natives, axes[a].foreignKey] : axes[a].natives\n\t\t\t)',
				why: "Covers dropped: a family installs neither its last axis's nor its closure's foreign key, so a gap below the count commits, and a state the families theorem fails is committed."
			}
		]
	})
