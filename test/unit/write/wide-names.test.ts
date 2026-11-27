/**
 * A wide write's statement grows by its parts alone, in the AST it prints and in the names PostgreSQL 19's planner asks
 * planning it, and every name it asks for a level of the write is asked once.
 *
 * PostgreSQL 19 names every sub-query it plans apart, scanning every name its planning of the statement has used for each
 * candidate (planner.c choose_plan_name): a name already used, or one always numbered (`exists`, `setop`, ...), takes
 * `<name>_1`, `<name>_2`, ... until one is new, so n asks of one name over k names used cost about n²k/4 comparisons,
 * the larger part of a wide write's planning (metis's start statement 7: 2,692 names, about 1,150 of its 1,480 ms of
 * planning, lane PRINTONCE4). That cost is PostgreSQL's; grizzle's part is the names its statement makes PostgreSQL ask,
 * held here to its derived bound: a fixed set of derivations per part, each planned once, so the statement's AST and the
 * levels its plan names grow by the parts alone (test/support/growth.ts affine); and each level PostgreSQL plans apart
 * is named by the alias its transaction's advice scope minted for it (sql/naming.ts AdviceScope, sql/plan.ts ReadPlan),
 * every one of them new, so no ask of one is answered by a retry.
 *
 * Box: an insert of a fact into each of n, 2n and 3n relations, n two or three, each relation keyed by its id and keyed
 * again, so each part is the guarded insert of new keys with its unique probe and refusal.
 *
 * Oracle: the write's own plan (write/program/served.ts ServableWrite `plan`), the levels it names, each a name
 * PostgreSQL asks, and the universal relation of an affine size.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { affine } from "#test/support/growth.ts"
import { step, wideInsert } from "#test/unit/write/wide-names.fixtures.ts"

/** A wide write's statement grows by its parts alone, in AST and in the levels its plan names, each named once. */
export const aWideWritesStatementGrowsByItsPartsAloneInItsAstAndInTheLevelsItsPlanNamesEachOnce =
	property.exhaust(
		finite((source) => source.draw(step)),
		{
			needs: {},
			situations: [],
			check: () => (n) =>
				Effect.sync(() => {
					const measured = new Map(Arr.map([n, 2 * n, 3 * n], (k) => [k, wideInsert(k)] as const))
					const at = (k: number) => defined(measured.get(k), `the write of ${k} relations`)
					for (const [k, planned] of measured) {
						assert.deepEqual(
							planned.levels,
							Arr.dedupe(planned.levels),
							`a write of ${k} relations names each level of its plan once`
						)
					}
					affine(
						(k) => at(k).nodes,
						n,
						"the printed statements' AST nodes over the write's relations"
					)
					affine(
						(k) => at(k).levels.length,
						n,
						"the levels PostgreSQL plans apart, each a name it asks, over the write's relations"
					)
				}),
			oracle: {
				kind: "universal",
				name: "f(3n) − f(2n) = f(2n) − f(n), each level of the write's plan named once"
			},
			box: "an insert into two or three relations, and twice and three times as many",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/sql/naming.ts",
					original: "\t\tthis.#next += 1",
					replacement: "\t\tthis.#next += 0",
					why: "The advice scope mints one alias over and over: every level the write's plan names is named alike, and PostgreSQL asks each name past the first again and again, `<name>_1`, `<name>_2`, ..., the n²k/4 of planner.c choose_plan_name."
				},
				{
					file: "packages/engine/src/lower/parts.ts",
					original:
						"\t\tconst padding: ReadonlyArray<Expr> = Array.from({ length: width - p.columns.length }, () =>",
					replacement:
						"\t\tconst padding: ReadonlyArray<Expr> = Array.from({ length: width - p.columns.length + parts.length }, () =>",
					why: "Every arm of the write's statement is padded by one column per part (lower/parts.ts taggedArms), an arm that grows with its siblings: the statement's AST grows by a term in the square of its parts."
				}
			]
		}
	)
