/**
 * A wide write's statement grows by its parts alone, in the AST it prints and in the names PostgreSQL 19's planner asks
 * planning it, and no INSERT's rows are planned under PostgreSQL 19's name for a sub-query without an alias.
 *
 * PostgreSQL 19 names every sub-query it plans apart, scanning every name its planning of the statement has used for each
 * candidate (planner.c choose_plan_name): a name already used, or one always numbered (`exists`, `setop`, ...), takes
 * `<name>_1`, `<name>_2`, ... until one is new, so n asks of one name over k names used cost about n²k/4 comparisons,
 * the larger part of a wide write's planning (metis's start statement 7: 2,692 names, about 1,150 of its 1,480 ms of
 * planning, lane PRINTONCE4). That cost is PostgreSQL's; grizzle's part is the names its statement makes PostgreSQL ask,
 * held here to its derived bound: a fixed set of derivations per part, each planned once, so every family grows by the
 * parts alone (test/support/growth.ts affine), and the INSERT of each part's new keys reads its key-ordered rows under a
 * name of its statement's own (write/insert/statement.ts keyOrderedSource), where its own sorted source, which has no
 * alias, was planned as `unnamed_subquery`, one more member of the family every filtered UNION ALL leaf of the statement
 * joins.
 *
 * Box: an insert of a fact into each of n, 2n and 3n relations, n two or three, each relation keyed by its id and keyed
 * again, so each part is the guarded insert of new keys with its unique probe and refusal.
 *
 * Oracle: PostgreSQL 19's naming as its planner's rules state it, read off the printed AST (test/support/planner-names.ts:
 * prepjointree.c, subselect.c, prepunion.c), which asks exactly the names an instrumented 19.0 logged planning this box's
 * statements at 4 and 8 relations, name for name and comparison for comparison; and the universal relation of an affine
 * size.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { affine } from "#test/support/growth.ts"
import {
	asked,
	asking,
	families,
	printedNodes,
	step,
	unaliasedOutsideLeaves,
	wideInsert
} from "#test/unit/write/wide-names.fixtures.ts"

/** A wide write's statement grows by its parts alone, in AST and in the names PostgreSQL asks, and names every INSERT's rows its own way. */
export const aWideWritesStatementGrowsByItsPartsAloneInItsAstAndInTheNamesPostgresqlAsksAndNamesEveryInsertsRowsItsOwnWay =
	property.exhaust(
		finite((source) => source.draw(step)),
		{
			needs: {},
			situations: [],
			check: () => (n) =>
				Effect.sync(() => {
					const measured = new Map(Arr.map([n, 2 * n, 3 * n], (k) => [k, wideInsert(k)] as const))
					const at = (k: number) => measured.get(k) ?? []
					for (const [k, planned] of measured) {
						const stray = unaliasedOutsideLeaves(planned)
						assert.equal(
							stray.length,
							0,
							`a write of ${k} relations plans ${stray.length} sub-quer${stray.length === 1 ? "y" : "ies"} as "unnamed_subquery" outside a UNION ALL's leaves (${Arr.join(
								Arr.map(stray, (a) => a.site),
								", "
							)}): an INSERT's rows planned under PostgreSQL 19's name for no alias`
						)
					}
					affine(
						(k) => printedNodes(at(k)),
						n,
						"the printed statements' AST nodes over the write's relations"
					)
					affine((k) => asked(at(k)), n, "the names PostgreSQL asks over the write's relations")
					for (const family of families) {
						affine(
							(k) => asking(at(k), family),
							n,
							`the "${family}" names PostgreSQL asks over the write's relations`
						)
					}
				}),
			oracle: {
				kind: "universal",
				name: "f(3n) − f(2n) = f(2n) − f(n), no INSERT source planned as unnamed_subquery"
			},
			box: "an insert into two or three relations, and twice and three times as many",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/write/insert/statement.ts",
					original: "\t\tquery: select(",
					replacement: "\t\tquery: true ? { ...rows, orderBy: key } : select(",
					why: "An INSERT of new keys reads its own sorted rows, as it did before keyOrderedSource: PostgreSQL 19 plans that source, which has no alias, as unnamed_subquery, every part's INSERT one more ask of the name the statement's filtered UNION ALL leaves share."
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
