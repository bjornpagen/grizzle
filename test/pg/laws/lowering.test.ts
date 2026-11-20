/**
 * A containment into a derived relation, lowered to foreign keys, against the same containment discharged by triggers,
 * on PostgreSQL 19.
 *
 * The theory lowers contained(on(S, s̄), on(D, h̄)) to native objects where D's definition meets seven conditions
 * (analysis/theory/laws.ts RuleLowering): each match of the definition a part, referenced from S by a foreign key
 * DEFERRABLE INITIALLY DEFERRED into a UNIQUE over the match's head and constant fields, S holding a `__tag_` constant
 * column for each constant. The oracle is the same schema installed through conservativeInstallation
 * (physical/install/compile.ts), every rule over a query discharged by its deferred constraint triggers, which the
 * rule-query suites hold to the rule's meaning. Each shape is its own property, its installations each migrated once per
 * member as a template of its own (test/support/install-migrate.ts migratedTemplate); a shape whose plan carries the
 * rule by a foreign key is installed again through each history (lowering-support.ts histories), so its declared
 * keys' indexes and its lowering's UNIQUE are created in every order a deployment creates them.
 *
 * - **The oracle, a second implementation:** each transaction of a case runs on the oracle and on every lowered
 *   installation of the shape, fresh and through each history. A direct SQL writer's transaction commits on one exactly when it commits on the other, and
 *   a refusal is at the same moment with the same SQLSTATE, its constraint mapped through each installation's own
 *   constraint map to the same law. A write grizzle serves on the lowered installation, a ChangeSet of inserts and
 *   deletes, is accepted exactly when the same facts written by SQL commit on the oracle, and a refusal names the law
 *   the oracle's refusal names, the rule's witnessed `unreported`, as the triggers' COMMIT is. After every case each
 *   table holds the same rows on both.
 * - **A duplicate names its key, by itself:** a statement the lowered installation refuses with 23505 writes a row
 *   that repeats an earlier row on a declared key, and the refusal names that key's law, never the rule's, whichever
 *   index PostgreSQL refused it on: PostgreSQL inserts a row's index entries in the order of their indexes' OIDs, and a
 *   history that creates the key after the lowering's UNIQUE over a superkey of it has that UNIQUE refuse it first. A
 *   served write a declared key refuses is witnessed at that key's fields of a row it inserts, never a superkey's.
 * - **A broken containment names the rule, by itself:** every 23503 on the lowered installation maps to the rule's law.
 * - **One decision in every order:** every installation of a shape, fresh and through each history, carries the rule
 *   by a foreign key exactly when the fresh one does, and the oracle by none. Which definitions the theory lowers is
 *   test/unit/laws/lowered-rules.test.ts's, the seven conditions restated over generated definitions; here a shape that
 *   lowers is held to the triggers' verdicts, whatever natives it lowers to.
 *
 * The box (lowering-support.ts): nineteen shapes of D, eight meant to meet every condition and eleven to fail exactly
 * one, each condition by at least one; A, B and S over small domains, so a draw reaches a source row with no target,
 * the delete of a target row a source row references, a target outside D's constants, a duplicate of a primary key and
 * of a candidate key beside a superkey of it; histories of up to six transactions of up to three statements, by SQL on
 * both installations or served by grizzle on the lowered one. A shape whose rule its fresh installation's plan carries by a
 * foreign key is also installed through each history.
 *
 * Features: a committed source row, the rule refusing a source row's write and a target row's, a served write
 * accepted and refused by the rule; for a shape whose matches fix a constant, a target outside it refused; and, where
 * the fresh installation's plan holds a UNIQUE the lowering adds over a superkey of a declared key, each duplicate
 * beside it (lowering.fixtures.ts situationsOf), read off the plan, whose decision every installed catalog is held to,
 * never off a table of what each shape should lower to.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, family, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import {
	caseGen,
	type Feature,
	loweredShapes,
	loweringCase,
	loweringTemplatesOf,
	pairIn,
	unloweredShapes
} from "#test/pg/laws/lowering.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A lowered shape commits and refuses every history exactly as the containment's triggers do, naming the same law, and
 * refuses a duplicate by its key before any superkey of it in every install order: one property for each shape whose
 * plan carries the rule by a foreign key, each case on the worker's seats of its shape's installations, fresh, through
 * each history, and the oracle's, each installed once per member.
 *
 * Its pre-conversion budget: runs 32, coverage cases 240 each, the steered cases measured on 4fdaafc3: the slowest
 * shape's last required feature, fixedTwo's "refused by the rule, a target row's write", is reached in the steered
 * window that ends at case 192 (at 176 it is not), candidatePair's at 160, existential's at 128, headFixed's at 112 and
 * doubled's at 48; 240 is three windows of 16 past the slowest (test/pg/laws/lowering.test.ts at fa10bca50).
 */
export const aLoweredShapeCommitsAndRefusesEveryHistoryExactlyAsTheContainmentsTriggersDo = family(
	Rec.fromEntries(
		Arr.map(loweredShapes, (planned) => {
			const t = loweringTemplatesOf(planned.shape)
			return [
				planned.shape,
				property.explore(caseGen, {
					needs: {
						fresh: Substrate.seat(t.fresh),
						aboveLater: Substrate.seat(t.histories.aboveLater),
						keysLater: Substrate.seat(t.histories.keysLater),
						keyChanged: Substrate.seat(t.histories.keyChanged),
						oracle: Substrate.seat(t.oracle)
					},
					situations: planned.situations satisfies ReadonlyArray<Reached<Feature>>,
					check:
						({ fresh, aboveLater, keysLater, keyChanged, oracle }, c: Case<Feature>) =>
						(lc) =>
							Effect.scoped(
								Effect.gen(function* () {
									const freshSeat = yield* fresh
									const reached = [
										["aboveLater", yield* aboveLater],
										["keysLater", yield* keysLater],
										["keyChanged", yield* keyChanged]
									] as const
									const oracleSeat = yield* oracle
									const pair = yield* pairIn(planned, freshSeat, reached, oracleSeat)
									yield* loweringCase(pair)(lc, c)
								})
							),
					oracle: {
						kind: "second-implementation",
						name: "the same schema installed through conservativeInstallation, every rule over a query discharged by its triggers"
					},
					show: Formatter.format,
					budget: { runs: 32, steered: 240 },
					kept: [],
					kills: []
				})
			] as const
		})
	)
)

/**
 * A shape whose plan discharges the rule by its triggers commits and refuses every history exactly as the oracle's
 * triggers do, naming the same law: one property for each such shape, each case on the worker's seats of its shape's
 * fresh installation and the oracle's, each installed once per member.
 *
 * Its pre-conversion budget: runs 32, coverage cases 240 each (test/pg/laws/lowering.test.ts at fa10bca50).
 */
export const anUnloweredShapeCommitsAndRefusesEveryHistoryExactlyAsTheContainmentsTriggersDo =
	family(
		Rec.fromEntries(
			Arr.map(unloweredShapes, (planned) => {
				const t = loweringTemplatesOf(planned.shape)
				return [
					planned.shape,
					property.explore(caseGen, {
						needs: { fresh: Substrate.seat(t.fresh), oracle: Substrate.seat(t.oracle) },
						situations: planned.situations satisfies ReadonlyArray<Reached<Feature>>,
						check:
							({ fresh, oracle }, c: Case<Feature>) =>
							(lc) =>
								Effect.scoped(
									Effect.gen(function* () {
										const freshSeat = yield* fresh
										const oracleSeat = yield* oracle
										const pair = yield* pairIn(planned, freshSeat, [], oracleSeat)
										yield* loweringCase(pair)(lc, c)
									})
								),
						oracle: {
							kind: "second-implementation",
							name: "the same schema installed through conservativeInstallation, every rule over a query discharged by its triggers"
						},
						show: Formatter.format,
						budget: { runs: 32, steered: 240 },
						kept: [],
						kills: []
					})
				] as const
			})
		)
	)
