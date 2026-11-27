/**
 * Ordering laws between a span and points of other relations on PostgreSQL 19: a sitting's visits lie after its start
 * and, once it has one, before its end, each bound a row check over a join of the visits with one of the two points, a
 * rule over a query (README, Rules over queries). A sitting with no end has no fact of the join with its end, so the end
 * bound asks nothing of it: an open sitting is the absence of its end, never a span unbounded above, and every span
 * stays bounded and non-empty.
 *
 * The schema (ordering.fixtures.ts orderingOf): each bound inclusive (a visit may start at the start and end at the
 * end), the visits immutable, so the judge reads each sitting a transaction wrote whole. Each case is a history of
 * direct SQL transactions at SERIALIZABLE over two sittings: starts and ends inserted and deleted, visits inserted and
 * deleted, a transaction that deletes one a data step (data-step.ts asDataStep), the one way a closed relation loses
 * a fact, which its judge judges at its COMMIT as it judges every other.
 *
 * - **The host judges alike:** mid-transaction, each row of each join the tables hold is evaluated by the host
 *   (rowEvaluator, the one evaluation grizzle judges a refused write's rows by), and the rows and verdicts are exactly
 *   the restatement's: each definition restated over the facts, each bound restated over each fact.
 * - **PostgreSQL enforces it:** SET CONSTRAINTS ALL IMMEDIATE runs the judge, which refuses exactly when the restatement
 *   finds a bound broken, by 23514 naming a broken bound's name (constraintNamesOf), and the transaction commits
 *   otherwise.
 *
 * Features: a commit; an open sitting's visit committed; a refusal by each bound; a start written after its visits and
 * an end written before a visit's end, each refused alone, a point's write breaking the law over the visits; and a
 * bound met exactly, committed.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import {
	aims,
	caseGen,
	type Feature,
	judgeHistory,
	orderingTemplate,
	required
} from "#test/pg/laws/ordering.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Commit exactly the transactions whose visits lie within their sittings' start and end, an open sitting's after its
 * start alone, the host judging each joined row as the restatement does, each case on its own clone of the schema.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const commitExactlyTheTransactionsWhoseVisitsLieWithinTheirSittingsStartAndEnd =
	property.explore(aimed(caseGen, aims), {
		needs: { fresh: Substrate.fresh(orderingTemplate) },
		situations: required satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ fresh }, k: Case<Feature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(fresh, (taken) =>
						Effect.provideService(judgeHistory(taken, c, k.note), Substrate, taken.substrate)
					)
				),
		oracle: {
			kind: "specification",
			name: "the ordering restated over the facts: each join's facts and each bound's verdict on them, which the host's evaluation of the rows the database holds must match, and a transaction commits exactly when no bound breaks"
		},
		show: Formatter.format,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/builders.ts",
				original: '\tlower: spanPart("lower"),',
				replacement: '\tlower: spanPart("upper"),',
				why: "A span's lower end read as its upper: a visit that starts before its sitting's start but ends after it is judged in order, by the host and by the judge alike."
			}
		]
	})
