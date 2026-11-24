/**
 * The rows audit (test/support/oracle/verify/rows.ts), the oracle the lowering suites hold every statement to: a
 * statement is refused exactly where its rows may repeat where a set is required. Each rule is exhausted over a small
 * space of statements built for it:
 *
 * - a derived table or a CTE whose rows may repeat is refused under a reader whose rows a repeat changes (a key claim, a
 *   certificate, an input read, a count), and admitted under DISTINCT, a repeat-blind aggregate or EXISTS;
 * - a bound over rows that may repeat is refused unless it is LIMIT 1 alone, which keeps one of equal rows;
 * - a one-row claim holds by its shape (no FROM, aggregates without GROUP BY) or under a LIMIT 1;
 * - a groups claim holds where every GROUP BY expression is a target.
 *
 * A verdict is whether the audit refuses, never how many violations it lists.
 *
 * Oracle: each rule restated apart from the audit (needsSet, repeats and the shapes' own statements), a second
 * implementation. Features: a GROUP BY expression a target and one no target.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	core,
	countStar,
	derived,
	distinctCore,
	grouped,
	lit,
	operandSelect,
	proved,
	select,
	table,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { rowsViolations } from "#test/support/oracle/verify/rows.ts"
import {
	bodies,
	bounded,
	bounds,
	chosen,
	distinctRead,
	groupColumn,
	groupColumns,
	type GroupsFeature,
	groupTargets,
	needsSet,
	oneRowCores,
	plainRead,
	read,
	readerOf,
	readers,
	repeats,
	sourceOf,
	sources,
	statementOf,
	targetExpr
} from "#test/unit/sql/rows.fixtures.ts"

/** The rows audit (oracle/verify/rows.ts) refuses exactly the derived tables and CTEs whose rows may repeat under a reader they change. */
export const theRowsAuditOracleVerifyRowsTsRefusesExactlyTheDerivedTablesAndCTEsWhoseRowsMayRepeatUnderAReaderTheyChange =
	property.exhaust(
		finite((s) => ({
			reader: s.draw(element(readers)),
			source: s.draw(element(sources))
		})),
		{
			needs: {},
			situations: [],
			check:
				() =>
				({ reader, source }) =>
					Effect.sync(() => {
						const s = sourceOf(source)
						const violations = rowsViolations(statementOf(readerOf(reader, s.from), s.cte))
						assert.equal(
							violations.length > 0,
							needsSet(reader) && repeats(source),
							Arr.join(violations, "; ")
						)
					}),
			oracle: {
				kind: "second-implementation",
				name: "needsSet and repeats, the readers that count repeats over the sources that may hold them"
			},
			box: "seven readers of one column over a table, a derived table or a CTE, each a set or rows that may repeat",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/sql/ast.ts",
					original: '\t\t\treturn body.distinct !== false || body.rows !== "operand"',
					replacement: '\t\t\treturn body.distinct !== false || body.rows === "operand"',
					why: "Operator mutant (comparison) at packages/engine/src/sql/ast.ts:957 in isSetBody: `!==` becomes `===`; the property fails (lane CATCH, grizzle 0baff5d6)."
				},
				{
					file: "packages/engine/src/sql/ast.ts",
					original: '\t\t\treturn body.distinct !== false || body.rows !== "operand"',
					replacement: '\t\t\treturn body.distinct !== false || body.rows === "operand"',
					why: "Operator mutant (comparison) at packages/engine/src/sql/ast.ts:957 in isSetBody: `!==` becomes `===`; the property fails (lane CATCH, grizzle 0baff5d6)."
				}
			]
		}
	)

/**
 * The rows audit (oracle/verify/rows.ts) refuses a bound that counts repeated rows, LIMIT 1 alone keeping one of equal
 * rows, and OFFSET 0 alone, a fence, counting none.
 */
export const theRowsAuditOracleVerifyRowsTsRefusesABoundThatCountsRepeatedRowsLIMIT1AloneKeepingOneOfEqualRows =
	property.exhaust(
		finite((s) => ({ body: s.draw(element(bodies)), bound: s.draw(element(bounds)) })),
		{
			needs: {},
			situations: [],
			check:
				() =>
				({ body, bound }) =>
					Effect.sync(() => {
						const query = operandSelect(body === "set" ? distinctRead("r3") : plainRead("r3"))
						const statement = select(
							distinctCore(
								[targetAs(read("r2"), "c1")],
								[derived(bounded(query, bound), "r2", false)],
								undefined
							)
						)
						const counted = body === "operand" && (bound === "LIMIT 2" || bound === "OFFSET 1")
						assert.equal(rowsViolations(statement).length > 0, counted, `${body} ${bound}`)
					}),
			oracle: {
				kind: "specification",
				name: "a bound counts the rows it reads: only LIMIT 1 alone keeps one of equal rows, and OFFSET 0 counts none"
			},
			box: "a set body and a body that may repeat rows, each unbounded, under LIMIT 1, LIMIT 2, OFFSET 1 and OFFSET 0",
			kept: [],
			kills: [
				{
					file: "test/support/oracle/verify/rows.ts",
					original:
						"\tq.limit !== undefined || (q.offset !== undefined && !isLiteralZero(q.offset))",
					replacement: "\tq.limit !== undefined || q.offset !== undefined",
					why: "OFFSET 0, the fence a step read per row carries (lower/conservative/step fencedRead), counts the rows of a body that may repeat them, so the audit refuses every existence test read per left row."
				},
				{
					file: "packages/engine/src/sql/ast.ts",
					original: '\t\t\treturn body.distinct !== false || body.rows !== "operand"',
					replacement: '\t\t\treturn body.distinct !== false || body.rows === "operand"',
					why: "Operator mutant (comparison) at packages/engine/src/sql/ast.ts:957 in isSetBody: `!==` becomes `===`; the property fails (lane CATCH, grizzle 0baff5d6)."
				},
				{
					file: "packages/engine/src/sql/ast.ts",
					original: '\t\t\treturn body.distinct !== false || body.rows !== "operand"',
					replacement: '\t\t\treturn body.distinct !== false || body.rows === "operand"',
					why: "Operator mutant (comparison) at packages/engine/src/sql/ast.ts:957 in isSetBody: `!==` becomes `===`; the property fails (lane CATCH, grizzle 0baff5d6)."
				}
			]
		}
	)

/** The rows audit (oracle/verify/rows.ts) holds a one-row claim to its shape or a LIMIT 1 over it. */
export const theRowsAuditOracleVerifyRowsTsHoldsAOneRowClaimToItsShapeOrALIMIT1OverIt =
	property.exhaust(
		finite((s) => ({
			shape: s.draw(element(oneRowCores)),
			limited: s.draw(element([false, true]))
		})),
		{
			needs: {},
			situations: [],
			check:
				() =>
				({ shape, limited }) =>
					Effect.sync(() => {
						const c =
							shape === "no FROM"
								? core([target(lit.int(1, types.integer))], [], undefined)
								: core(
										[targetAs(shape === "an aggregate" ? countStar() : read("r1"), "c1")],
										[table("w", "t", "r1")],
										undefined
									)
						const query = select(proved("oneRow", c))
						const statement = limited ? { ...query, limit: lit.int(1, types.integer) } : query
						assert.equal(
							rowsViolations(statement).length > 0,
							shape === "a column" && !limited,
							`${shape} ${limited ? "under LIMIT 1" : "unbounded"}`
						)
					}),
			oracle: {
				kind: "specification",
				name: "one row: no FROM, aggregates and no GROUP BY, or a LIMIT 1 over the core"
			},
			box: "a core of no FROM, of an aggregate over a table and of a column of a table, each under LIMIT 1 or none",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/sql/ast.ts",
					original: '\t\t\treturn body.distinct !== false || body.rows !== "operand"',
					replacement: '\t\t\treturn body.distinct !== false || body.rows === "operand"',
					why: "Operator mutant (comparison) at packages/engine/src/sql/ast.ts:957 in isSetBody: `!==` becomes `===`; the property fails (lane CATCH, grizzle 0baff5d6)."
				},
				{
					file: "packages/engine/src/sql/ast.ts",
					original: '\t\t\treturn body.distinct !== false || body.rows !== "operand"',
					replacement: '\t\t\treturn body.distinct !== false || body.rows === "operand"',
					why: "Operator mutant (comparison) at packages/engine/src/sql/ast.ts:957 in isSetBody: `!==` becomes `===`; the property fails (lane CATCH, grizzle 0baff5d6)."
				}
			]
		}
	)

/** The rows audit (oracle/verify/rows.ts) holds a groups claim to each GROUP BY expression being a target. */
export const theRowsAuditOracleVerifyRowsTsHoldsAGroupsClaimToEachGROUPBYExpressionBeingATarget =
	property.exhaust(
		finite((s) => ({
			targets: s.draw(int(1, 2 ** groupTargets.length - 1)),
			groupBy: s.draw(int(1, 2 ** groupColumns.length - 1))
		})),
		{
			needs: {},
			situations: [
				"every GROUP BY expression a target",
				"a GROUP BY expression no target"
			] satisfies ReadonlyArray<Reached<GroupsFeature>>,
			check:
				(_, c: Case<GroupsFeature>) =>
				({ targets, groupBy }) =>
					Effect.sync(() => {
						const shown = chosen(groupTargets, targets)
						const by = chosen(groupColumns, groupBy)
						const statement = select(
							grouped(
								core(
									Arr.map(shown, (t, i) => targetAs(targetExpr(t), `c${i + 1}`)),
									[table("w", "t", "r1")],
									undefined
								),
								Arr.map(by, (column) => groupColumn(column))
							)
						)
						const targeted = Arr.every(by, (column) =>
							Arr.some(shown, (t) => t.kind === "column" && t.column === column)
						)
						c.note(
							targeted ? "every GROUP BY expression a target" : "a GROUP BY expression no target"
						)
						assert.equal(rowsViolations(statement).length > 0, !targeted, Formatter.format(by))
					}),
			oracle: {
				kind: "specification",
				name: "each group one row: every GROUP BY expression is among the core's targets"
			},
			box: "a core claiming its groups, its targets every nonempty set of two columns and a count, grouped by every nonempty set of the two columns",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/sql/ast.ts",
					original: '\t\t\treturn body.distinct !== false || body.rows !== "operand"',
					replacement: '\t\t\treturn body.distinct !== false || body.rows === "operand"',
					why: "Operator mutant (comparison) at packages/engine/src/sql/ast.ts:957 in isSetBody: `!==` becomes `===`; the property fails (lane CATCH, grizzle 0baff5d6)."
				},
				{
					file: "packages/engine/src/sql/ast.ts",
					original: '\t\t\treturn body.distinct !== false || body.rows !== "operand"',
					replacement: '\t\t\treturn body.distinct !== false || body.rows === "operand"',
					why: "Operator mutant (comparison) at packages/engine/src/sql/ast.ts:957 in isSetBody: `!==` becomes `===`; the property fails (lane CATCH, grizzle 0baff5d6)."
				}
			]
		}
	)
