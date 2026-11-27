/**
 * A pass-through projection's fold on PostgreSQL 19 (sql/print.ts passedThrough, foldedCore): a core whose every
 * target is a column of the one derived table it reads prints as the core it reads, and the statement means what it
 * meant. Over drawn stacks of projections and aggregates over VALUES rows, read by the statement's rows, under its
 * ORDER BY, parenthesized under an ORDER BY of its output names, through a CTE and as an IN's subquery,
 * the folded statement answers exactly its twin's names and rows, its twin being the same statement with every core
 * over a derived table guarded by WHERE TRUE, which no fold reads through, and pulled up as the statement is
 * (sql/pull-up.ts, bcb057d552), each guard conjoined with the WHERE of a sub-query flattened into its core; and its
 * text adds no token its twin lacks beyond a copy of a column or a literal read twice, calls what its twin calls and
 * holds its twin's placeholders in their order.
 *
 * Oracle: PostgreSQL, on the twin.
 *
 * Features: a fold read by name, under an ORDER BY through parentheses among them, and by place; a core kept under its
 * query's ORDER BY; a placeholder, an aggregate, a set-returning call and a volatile call under a fold; a column read
 * twice.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	answered,
	type FoldFeature,
	foldCase,
	foldSketchGen,
	guardsOf,
	reachedOf,
	selects,
	tokenViolations
} from "#test/pg/sql/fold.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * A folded statement answers its unfolded twin's names and rows, and its text adds no token, drops no call and keeps
 * its placeholders in their order.
 */
export const aFoldedStatementAnswersItsUnfoldedTwinsNamesAndRowsAndItsTextAddsNoTokenDropsNoCallAndKeepsItsPlaceholders =
	property.explore(foldSketchGen, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [
			"a projection folded",
			"a fold read by name",
			"a fold read by place",
			"kept under its query's ORDER BY",
			"a fold read by name under an ORDER BY through parentheses",
			"a placeholder folded",
			"an aggregate kept",
			"a set-returning call kept",
			"a volatile call kept",
			"a column read twice"
		] satisfies ReadonlyArray<Reached<FoldFeature>>,
		check:
			({ tx }, c: Case<FoldFeature>) =>
			(sketch) =>
				Effect.gen(function* () {
					const { connection: admin } = yield* tx
					const folded = foldCase(sketch, false)
					const twin = foldCase(sketch, true)
					const want = yield* answered(admin, twin)
					const got = yield* answered(admin, folded)
					assert.deepEqual(got.names, want.names, `the names of ${folded.text}`)
					assert.deepEqual(got.rows, want.rows, `the rows of ${folded.text}`)
					assert.deepEqual(
						tokenViolations(folded.text, twin.text, guardsOf(sketch)),
						[],
						folded.text
					)
					c.noteAll(reachedOf(sketch, selects(folded.text) < selects(twin.text)))
				}),
		oracle: {
			kind: "postgresql",
			name: "the statement's twin, every core over a derived table guarded by WHERE TRUE, which no fold reads through"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/sql/fold.test.ts#aFoldedStatementAnswersItsUnfoldedTwinsNamesAndRowsAndItsTextAddsNoTokenDropsNoCallAndKeepsItsPlaceholders:3ff.0:1.0.0.0.1.0.1.0.1.0.0.0.1.0"
				),
				reason:
					"a filtered level read by the statement's rows, its twin's guard conjoined by the printer's pull-up with the level's WHERE (bcb057d552), one WHERE and one AND where the token rule set two WHEREs apart, red on the merged tree",
				since: "2026-11-27"
			}
		],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original:
					'\t\treader === "ordered" || reader === "placedOrdered"\n\t\t\t? given\n\t\t\t: foldedCore(given, reader === "named")',
				replacement: '\t\tfalse\n\t\t\t? given\n\t\t\t: foldedCore(given, reader === "named")',
				why: "A core its query orders folds too, so the ORDER BY names a range the fold took away and PostgreSQL refuses the statement."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original:
					"\t\t\t: [{ at, expr: read.expr, alias: t.alias ?? (named && !kept ? t.expr.column : undefined) }]",
				replacement: "\t\t\t: [{ at, expr: read.expr, alias: t.alias }]",
				why: "A fold read by name loses its columns' names: the statement's rows are named by the inner targets, and an ORDER BY over a parenthesized body names columns it no longer has."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original:
					"\t\treturn reads === 1 || plain || (reads === 0 && !anyComputing && !holds(t.expr, binding))",
				replacement: "\t\treturn reads === 1 || plain || (reads === 0 && !anyComputing)",
				why: "An unread placeholder is left out, so PostgreSQL cannot type the parameter the statement is bound with."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original:
					"\t\treturn reads === 1 || plain || (reads === 0 && !anyComputing && !holds(t.expr, binding))",
				replacement: "\t\treturn reads === 1 || plain || (reads === 0 && !holds(t.expr, binding))",
				why: "An unread call is left out where the inner computes: an aggregate's one row becomes a row per input row, a set-returning call's rows are lost."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original:
					"\t\treturn reads === 1 || plain || (reads === 0 && !anyComputing && !holds(t.expr, binding))",
				replacement:
					"\t\treturn reads >= 1 || plain || (reads === 0 && !anyComputing && !holds(t.expr, binding))",
				why: "A computed target read twice is computed twice: a volatile call's two reads differ, and the text calls twice what its twin calls once."
			}
		]
	})
