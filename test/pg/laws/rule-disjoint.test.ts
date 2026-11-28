/**
 * A unit-local rule over a query is judged whole over the units a transaction wrote (physical/ddl/rules.ts addRules,
 * analysis/theory/unit.ts), and its judge reads those units' rows alone, by the unit-led indexes it asks
 * (physical/ddl/rules.ts requestsOf): so transactions that write disjoint units, each keeping every rule, never depend
 * on one another, and SERIALIZABLE commits every one of them, however their statements interleave. On PostgreSQL 19,
 * over Disjoint (rule-disjoint.fixtures.ts): T, U and S keyed by their unit first, a containment of T ⋈ U into S and a
 * check over the join, both whole.
 *
 * Each case loads hundreds of units, analyzed, so PostgreSQL reads a written unit by its index, and writes two to four
 * new units at once, each in a transaction of its own, every statement of each and its COMMIT run in a drawn order.
 * Spaced units lie a hundred stored units apart, so no leaf page of a unit-led index holds two of them: an index INSERT
 * is checked against the predicate locks on its leaf page, and a heap INSERT against relation-level ones alone, so a
 * judge that reads its unit's pages alone takes no lock another unit's writes meet.
 *
 * Adjacent units lie at consecutive packages and share their boundary leaf pages: PostgreSQL's page-level predicate
 * locks couple them whatever grizzle reads, so a transaction of theirs may meet a serialization failure, which the
 * property allows; a judge holding a relation's predicate lock, which couples it to every writer's INSERT, is refused
 * there as anywhere. Not judged: a unit table read by its key on a page every unit's row lands on (a content package's
 * Package row), read and written by every writer, which couples every unit at that page.
 *
 * Oracle: universal: every transaction writing spaced units commits, its judge and COMMIT refusing nothing, one writing
 * adjacent units commits or meets a serialization failure, and no judge holds a relation's predicate lock; a refusal
 * names the transaction, every transaction's predicate locks before its COMMIT, and the database's at the refusal.
 *
 * Features: two units at once and three or four, a unit committed before another's first write, every unit's writes
 * before any COMMIT, and adjacent units.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type ConcurrentFeature,
	concurrentGen,
	disjointTemplate,
	runConcurrent
} from "#test/pg/laws/rule-disjoint.fixtures.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Transactions that write units spaced apart, each keeping every whole rule, all commit under SERIALIZABLE, whatever
 * their interleaving, and no judge of theirs, adjacent units' among them, holds a relation's predicate lock.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from. A whole rule's index
 * request without its unit block is an equivalent mutant here: every relation leads its primary key with the unit, whose
 * index serves the read whatever the request asks; test/unit/physical/rule-requests kills it by plan.
 */
export const transactionsWritingSpacedUnitsUnderWholeRulesAllCommitUnderSERIALIZABLEAndNoJudgeLocksARelation =
	property.explore(concurrentGen, {
		needs: { disjoint: Substrate.fresh(disjointTemplate) },
		situations: [
			"two units at once",
			"three or four units at once",
			"a unit committed before another's first write",
			"every unit's writes before any COMMIT",
			"adjacent units"
		] satisfies ReadonlyArray<ConcurrentFeature>,
		check:
			({ disjoint }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { substrate, value } = yield* disjoint
					const loader = yield* substrate.session({ ...ownerSession(), label: "loader" })
					const sessions = yield* Effect.forEach(drawn.units, (_, j) =>
						substrate.session({ ...ownerSession(), label: `unit ${j}` })
					)
					yield* runConcurrent(value, loader, sessions, drawn, c)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "universal",
			name: "every transaction writing a unit of its own spaced from the others commits under SERIALIZABLE, one adjacent to another commits or meets a serialization failure, and no judge holds a relation's predicate lock"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					'\t\t\trestriction.kind === "region" ? unitStep(walkedText, unit, restriction.region) : walkedText,',
				replacement: "\t\t\twalkedText,",
				why: "No rule of a whole rule's violation query is read per unit of the region the transaction wrote, so each judge reads every unit stored and the rows the others put, and two transactions writing spaced units depend on each other both ways: SERIALIZABLE refuses one with 40001."
			}
		]
	})
