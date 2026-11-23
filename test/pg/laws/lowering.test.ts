/**
 * A containment into a derived relation, lowered to foreign keys, against the same containment discharged by triggers,
 * on PostgreSQL 19.
 *
 * The theory lowers contained(on(S, s̄), on(D, h̄)) to native objects where D's definition meets seven conditions
 * (analysis/theory/laws.ts RuleLowering): each match of the definition a part, referenced from S by a foreign key
 * DEFERRABLE INITIALLY DEFERRED into a UNIQUE over the match's head and constant fields, S holding a `__tag_` constant
 * column for each constant. The oracle is the same schema installed through conservativeInstallation
 * (physical/install/compile.ts), every rule over a query discharged by its deferred constraint triggers. Each shape is
 * its own property, its installations each migrated once per member as a template of its own
 * (test/support/install-migrate.ts migratedTemplate), fresh and again through each history (lowering-support.ts
 * histories), so its declared keys' indexes and its lowering's UNIQUE are created in every order a deployment creates
 * them.
 *
 * - **The oracle, a second implementation:** each transaction of a case runs on the oracle and on every lowered
 *   installation of the shape, fresh and through each history. A direct SQL writer's transaction commits on one exactly when it commits on the other, and
 *   a refusal is at the same moment with the same SQLSTATE, its constraint mapped through each installation's own
 *   constraint map to the same law. A write grizzle serves on the lowered installation, a ChangeSet of inserts and
 *   deletes, is accepted exactly when the same facts written by SQL commit on the oracle, and a refusal names the law
 *   the oracle's refusal names, the rule's witnessed `unreported` or by the key of a source row the state it leaves
 *   holds, which the lowered rule's deferred foreign key's witness query names at COMMIT where the triggers' COMMIT
 *   names none. After every case each table holds the same rows on both.
 * - **A duplicate names its key, by itself:** a statement the lowered installation refuses with 23505 writes a row
 *   that repeats an earlier row on a declared key, and the refusal names that key's law, never the rule's, whichever
 *   index PostgreSQL refused it on: PostgreSQL inserts a row's index entries in the order of their indexes' OIDs, and a
 *   history that creates the key after the lowering's UNIQUE over a superkey of it has that UNIQUE refuse it first. A
 *   served write a declared key refuses is witnessed at that key's fields of a row it inserts, never a superkey's.
 * - **A broken containment names the rule, by itself:** every 23503 on the lowered installation maps to the rule's law.
 * - **One decision in every order:** every installation of a shape, fresh and through each history, carries the rule
 *   by a foreign key, as its plan does, and the oracle by none. Which definitions the theory lowers is
 *   test/unit/laws/lowered-rules.test.ts's, the seven conditions restated over generated definitions; here a shape that
 *   lowers is held to the triggers' verdicts, whatever natives it lowers to.
 *
 * The box (lowering-support.ts): the two shapes of D whose containment references a superkey of its target's key, the
 * superkey's UNIQUE serving the containment beside the key: candidatePair's A (grp, v, kind) over key (grp, kind),
 * join's B (grp, tag) over key (grp); A, B and S over small domains, so a draw reaches a source row with no target, the
 * delete of a target row a source row references, a target outside D's constants, a duplicate of a primary key and of a
 * candidate key beside a superkey of it; histories of up to six transactions of up to three statements, by SQL on both
 * installations or served by grizzle on the lowered one.
 *
 * Features: a committed source row, the rule refusing a source row's write and a target row's, a served write
 * accepted and refused by the rule, a target outside the constant its match fixes refused; and, where the fresh
 * installation's plan holds a UNIQUE the lowering adds over a superkey of a declared key, each duplicate beside it
 * (lowering.fixtures.ts situationsOf), read off the plan, whose decision every installed catalog is held to.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, family, type Kept, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import type { Shape } from "#test/pg/laws/lowering-support.ts"
import {
	loweringSpaceOf,
	type Feature,
	loweredShapes,
	loweringCase,
	loweringTemplatesOf,
	pairIn
} from "#test/pg/laws/lowering.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A key's refusal names every law it serves (laws/model/model.ts refusedLaws), a containment it serves only as its
 * foreign key's referenced key among them: under keyChanged, which creates the superkey's index first, a duplicate of
 * the key is refused by the superkey naming the key and the containment, where the triggers' key names the key alone.
 */
const servedContainmentKill = {
	file: "packages/engine/src/laws/model/model.ts",
	original: '\t\t\t\treturn kind !== "containment" && kind !== "rule"\n',
	replacement: "\t\t\t\treturn true\n",
	why: "A key's refusal names a containment it serves only as a foreign key's referenced key (laws/model/model.ts refusedLaws): a duplicate refused by the superkey a containment references names that containment beside the key, where the triggers' installation names the key alone."
} as const

/** The cases found red each shape keeps, by its name (`kept`). */
const keptOf: Readonly<Record<Shape, ReadonlyArray<Kept>>> = {
	candidatePair: [
		{
			token: ReplayToken(
				"test/pg/laws/lowering.test.ts#aLoweredShapeCommitsAndRefusesEveryHistoryExactlyAsTheContainmentsTriggersDo/candidatePair:7fc0.9:0.0.1.0.0.0.0.1.0.0.0.0.0.1.1.0.0.1.0.0.0.0.0.1.0.0"
			),
			reason:
				"Under keyChanged, two rows of A at grp 0, v 0, kind 2: the superkey (grp, v, kind), its index created first, refused the duplicate naming key (grp, kind) and the containment S in D its foreign key references, where the triggers' key named the key alone (PERF-SCHEMA on hub 60dc18f76)",
			since: "2026-11-21"
		}
	],
	join: [
		{
			token: ReplayToken(
				"test/pg/laws/lowering.test.ts#aLoweredShapeCommitsAndRefusesEveryHistoryExactlyAsTheContainmentsTriggersDo/join:ffe0.5:0.0.1.0.0.0.0.1.2.0.0.0.0.0.0.1.0.0.0"
			),
			reason:
				"Under keyChanged, a second row of B at grp 0, tag 3: the superkey (grp, tag), its index created first, refused the duplicate naming key (grp) and the containment S in D its foreign key references, where the triggers' key named the key alone (PERF-SCHEMA on hub 60dc18f76)",
			since: "2026-11-21"
		}
	]
}

/**
 * A lowered shape commits and refuses every history exactly as the containment's triggers do, naming the same law, and
 * refuses a duplicate by its key before any superkey of it in every install order: one property for each shape, each
 * case on its own clones of its shape's installations, fresh, through each history, and the oracle's, each
 * installed once per member.
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
				property.explore(loweringSpaceOf(planned.shape), {
					needs: {
						fresh: Substrate.fresh(t.fresh),
						aboveLater: Substrate.fresh(t.histories.aboveLater),
						keysLater: Substrate.fresh(t.histories.keysLater),
						keyChanged: Substrate.fresh(t.histories.keyChanged),
						oracle: Substrate.fresh(t.oracle)
					},
					situations: planned.situations satisfies ReadonlyArray<Reached<Feature>>,
					check:
						({ fresh, aboveLater, keysLater, keyChanged, oracle }, c: Case<Feature>) =>
						(lc) =>
							Effect.scoped(
								Effect.gen(function* () {
									const takenFresh = yield* fresh
									const reached = [
										["aboveLater", yield* aboveLater],
										["keysLater", yield* keysLater],
										["keyChanged", yield* keyChanged]
									] as const
									const takenOracle = yield* oracle
									const pair = yield* pairIn(planned, takenFresh, reached, takenOracle)
									yield* loweringCase(pair)(lc, c)
								})
							),
					oracle: {
						kind: "second-implementation",
						name: "the same schema installed through conservativeInstallation, every rule over a query discharged by its triggers"
					},
					show: Formatter.format,
					budget: { runs: 32, steered: 240 },
					kept: keptOf[planned.shape],
					kills: [servedContainmentKill]
				})
			] as const
		})
	)
)
