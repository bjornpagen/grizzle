/**
 * Ordering laws between a span and points of other relations on PostgreSQL 19: a sitting's visits lie after its start
 * and, once it has one, before its end, each bound a row check over a join of the visits with one of the two points, a
 * rule over a query (README, Rules over queries). A sitting with no end has no fact of the join with its end, so the end
 * bound asks nothing of it: an open sitting is the absence of its end, never a span unbounded above, and every span
 * stays bounded and non-empty.
 *
 * The box of schemas (ordering.fixtures.ts shapes): each bound inclusive (a visit may start at the start and end at the
 * end) or strict, the visits immutable, so the judge reads each sitting a transaction wrote whole, or mutable, so it
 * probes the rows it wrote (analysis/theory/unit.ts wholeRule). One search per shape, each case a history of direct SQL
 * transactions at SERIALIZABLE over two sittings: starts and ends inserted and deleted, visits inserted, deleted and,
 * where they are mutable, moved.
 *
 * - **The host judges alike:** mid-transaction, each row of each join the tables hold is evaluated by the host
 *   (rowEvaluator, the one evaluation grizzle judges a refused write's rows by), and the rows and verdicts are exactly
 *   the restatement's: each definition restated over the facts, each bound restated over each fact.
 * - **PostgreSQL enforces it:** SET CONSTRAINTS ALL IMMEDIATE runs the judge, which refuses exactly when the restatement
 *   finds a bound broken, by 23514 naming a broken bound's name (constraintNamesOf), and the transaction commits
 *   otherwise.
 *
 * Features: a commit; an open sitting's visit committed; a refusal by each bound; a start written after its visits and
 * an end written before a visit's end, each refused alone, a point's write breaking the law over the visits; a bound
 * met exactly, committed where it is inclusive and refused where it is strict; and a visit moved out, refused.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, family, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import {
	aimsOf,
	caseGen,
	type Feature,
	judgeHistory,
	orderingTemplates,
	requiredOf,
	shapes
} from "#test/pg/laws/ordering.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Commit exactly the transactions whose visits lie within their sittings' start and end, an open sitting's after its
 * start alone, the host judging each joined row as the restatement does, one property for each shape, each case on the
 * worker's seat of its shape's schema.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const commitExactlyTheTransactionsWhoseVisitsLieWithinTheirSittingsStartAndEnd = family(
	Rec.fromEntries(
		Arr.map(shapes, (shape) => [
			shape,
			property.explore(aimed(caseGen(shape), aimsOf(shape)), {
				needs: { seated: Substrate.seat(orderingTemplates[shape]) },
				situations: requiredOf(shape) satisfies ReadonlyArray<Reached<Feature>>,
				check:
					({ seated }, k: Case<Feature>) =>
					(c) =>
						Effect.scoped(
							Effect.flatMap(seated, (taken) =>
								Effect.provideService(judgeHistory(taken, c, k.note), Substrate, taken.substrate)
							)
						),
				oracle: {
					kind: "specification",
					name: "the ordering restated over the facts: each join's facts and each bound's verdict on them, which the host's evaluation of the rows the database holds must match, and a transaction commits exactly when no bound breaks"
				},
				show: Formatter.format,
				kept: [],
				kills:
					shape === "inclusive"
						? [
								{
									file: "packages/engine/src/scalar/compute/builders.ts",
									original: '\tlower: spanPart("lower"),',
									replacement: '\tlower: spanPart("upper"),',
									why: "A span's lower end read as its upper: a visit that starts before its sitting's start but ends after it is judged in order, by the host and by the judge alike."
								}
							]
						: []
			})
		])
	)
)
