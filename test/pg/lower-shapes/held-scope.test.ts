/**
 * A node a row site's root holds once stays held only while every node under it is restricted at the root's own values
 * (lower/conservative/context.ts restrictedEnv): where a chain step's row site restricts the nodes under it at the
 * values of the steps before it, rows of the root's own FROM, each read lowers it in place, a keyed read per row. Before,
 * only a restriction of the held node itself released it: a held projection of no restriction of its own stayed held, its
 * CTE, defined at its first read, took the chain step's values, and its WITH named a relation it does not see. qti-pie's
 * ItemRefSection, its structure nodes held at the test and read by two fenced steps at each item ref's values, failed its
 * install so (the helper's c390, 02-structure statement 905, 42P01); a result_runner statement too.
 *
 * On PostgreSQL 19, magic-sets' ledger (held-scope.fixtures.ts): a learner's item sessions of a stage, their attempts and
 * marks, and a sitting of the stage; a read of the sitting with each pair of its stage's sessions that share an instant
 * attached, the attachment's child reading the stage's sessions, then one join of the marked attempts twice at a
 * session's place and the first's instant. Two to four sessions, one or two attempts each, at one to three instants,
 * learner 2 stored beside learner 1.
 *
 * Oracle: the read runs at PostgreSQL and its attachment holds exactly the pairs of learner 1's sessions that share an
 * instant, counted from the stored rows. Specification: one statement.
 *
 * Features: sessions sharing an instant, and none.
 *
 * A region's chain prints each step after every occurrence its derived table reads (lower/shapes/region readableOrder):
 * a step's correlation is lowered at the column of the occurrence that first binds its variable in placement order, which
 * the chain's rank order may place after it. On PostgreSQL 19, qti-pie's ledger judge's shape (held-scope.fixtures.ts
 * suspendedRead): each snapshot at a moment the call passes in, beside each suspension of the moment's sitting at or after
 * the snapshot's instant, the suspensions an import bound at that instant, ranked before the snapshots on their key. One
 * to three snapshots and suspensions, one or two moments, learner 2 stored beside learner 1.
 *
 * Oracle: the read runs at PostgreSQL and holds exactly the snapshots at the moments beside the suspensions at or after
 * them, counted from the stored rows. Specification: one statement.
 *
 * Features: a suspension after a snapshot, and none.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	heldOrderTemplate,
	heldScopeTemplate,
	type OrderFeature,
	orderGen,
	runOrder,
	runScope,
	type ScopeFeature,
	scopeGen
} from "#test/pg/lower-shapes/held-scope.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A join an attachment reads twice, held once at the sitting's keys, beside a chain that reads it at the values of the
 * steps before it, is read in place there, and the read is well scoped and right.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aHeldNodeRestrictedBelowAtAChainStepsValuesIsReadInPlace = property.explore(scopeGen, {
	needs: { stored: Substrate.rolledBack(heldScopeTemplate) },
	situations: [
		"sessions sharing an instant",
		"no two sessions sharing an instant"
	] satisfies ReadonlyArray<Reached<ScopeFeature>>,
	check:
		({ stored }, c) =>
		(drawn) =>
			Effect.gen(function* () {
				const { connection, value } = yield* stored
				yield* runScope(value, connection, drawn, c)
			}),
	oracle: {
		kind: "universal",
		name: "the read runs at PostgreSQL and its attachment holds exactly the pairs of the sitting's sessions that share an instant"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/lower/conservative/context.ts",
			original:
				"\t\t\t\t\t\t\t\t(!subtreeOf(node).has(under.id) ||\n\t\t\t\t\t\t\t\t\tnow.every((e) => [...relationsRead(e.value)].every((r) => held.inScope.has(r))))\n",
			replacement: "\t\t\t\t\t\t\t\ttrue\n",
			why: "A restriction of a node under the held one never releases it, as before, only the held node's own does: the join, a projection held at the sitting, stays held while the chain step's row site restricts the relations under it at the session's place, its CTE takes those values, and PostgreSQL refuses the read (42P01, a relation of the attachment's FROM read in its WITH)."
		}
	]
})

/**
 * A chain step whose correlation reads an occurrence the chain ranks after it is printed after that occurrence, and the
 * read is well scoped and right.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aChainStepIsPrintedAfterEveryOccurrenceItsCorrelationReads = property.explore(
	orderGen,
	{
		needs: { stored: Substrate.rolledBack(heldOrderTemplate) },
		situations: [
			"a suspension after a snapshot",
			"no suspension after a snapshot"
		] satisfies ReadonlyArray<Reached<OrderFeature>>,
		check:
			({ stored }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { connection, value } = yield* stored
					yield* runOrder(value, connection, drawn, c)
				}),
		oracle: {
			kind: "universal",
			name: "the read runs at PostgreSQL and holds exactly the snapshots at the moments beside the suspensions at or after them"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/region/index.ts",
				original:
					"\tconst placed = readableOrder(\n\t\torder.map((o) => partOf(o.occurrence)),\n\t\twithin\n\t).map((part) => ({\n",
				replacement: "\tconst placed = order.map((o) => partOf(o.occurrence)).map((part) => ({\n",
				why: "The chain takes its steps in its rank order alone, as before: the suspensions, ranked before the snapshots on their key, read the snapshots' instant through their correlation, which names the snapshots' alias before it is in scope, and the lowering's statement audit refuses the read; the property fails."
			}
		]
	}
)
