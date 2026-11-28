/**
 * A containment into a derived union of rules that each read one imported query is judged on PostgreSQL 19 as its
 * violation query reads it. SnapStage, the derived join of Snap, Item and Sess, is contained at every column in
 * InSession, a union of one, two or three rules over that join and Visit, each reading it as an import, compiled at its
 * own level or from a level above (test/support/unit/laws/union-import.schema.ts). Every relation is immutable and keyed by its
 * child first, so the containment is unit-local, judged whole over the children a transaction wrote. Navigation reads
 * the union whole, restricted inside to its reader's channels under names of its own (analysis/theory/navigate.ts
 * received), where it received them under the reader's names, which its own steps minted again, and the checker refused
 * the judge grizzle had built (metis's Delivery containment at delivery.ts:724).
 *
 * Each case writes a drawn state of two children in two parts, in one transaction rolled back after: the first part,
 * then the judge (SET CONSTRAINTS ALL IMMEDIATE); where it accepts, the second part, then the judge again, over the
 * children the second part wrote.
 *
 * Oracle: the containment's violation query lowered by the oracle baseline (deploy/snapshot/violation.ts
 * baselineRuleChecks) over the state: the judge refuses exactly when it finds a row, under the containment's name and an
 * integrity SQLSTATE, and the check over every row a migration runs finds a row exactly then.
 *
 * Features: a union of one, two and three rules; compiled from a level above; refused, by a second part's units among
 * them, and accepted.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	runUnion,
	type UnionFeature,
	unionCaseGen,
	unionFeatures,
	unionTemplates
} from "#test/pg/laws/union-import.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A containment into a union of derived rules that each inline one import is judged over the units a transaction wrote
 * exactly as its violation query finds the state.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aContainmentIntoAUnionOfDerivedRulesThatEachInlineOneImportIsJudgedOverTheUnitsATransactionWroteExactlyAsItsViolationQueryFindsTheState =
	property.explore(unionCaseGen, {
		needs: Substrate.oneOf(unionTemplates, Substrate.rolledBack),
		situations: unionFeatures satisfies ReadonlyArray<Reached<UnionFeature>>,
		check: (installed, c) => (drawn) =>
			Effect.gen(function* () {
				const { connection, value } = yield* installed[drawn.shape]
				yield* runUnion(value, connection, drawn, c)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the containment's violation query lowered by the oracle baseline: the judge refuses exactly when it finds a row"
		},
		kept: [],
		kills: []
	})
