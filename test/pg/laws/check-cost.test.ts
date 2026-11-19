/**
 * A law's full check, as the migration that adds or changes a rule runs it over every row (deploy/render/sql.ts
 * violationCheck), reads each row of the tables it checks a bounded number of times, on PostgreSQL 19.
 *
 * edullm's QTI cutover of 547 law checks ran 766.8 s on a production-scale copy, 284 s of it one check and 190 s
 * another, each asked as IF EXISTS (<violation query>): PostgreSQL plans an EXISTS sublink for its first row, like a
 * LIMIT 1 (src/backend/optimizer/plan/subselect.c make_subplan), and expects violations, since it estimates an anti
 * join's rows above zero, so it chose a nested loop over the target's materialized rows for each source row, cheapest to
 * the first row it expected. A law that holds returns none, so the loop ran to its end: __node_kind_in_declaration's
 * removed 1,806,876,555 pairs by its join filter, 366.8 s, where the query read whole by a merge anti join took 0.34 s.
 *
 * Property: for each case of the box, every statement the check's block plans, explained with ANALYZE as PL/pgSQL
 * plans it, touches at most its plan's nodes times the rows of the two tables (check-cost.fixtures.ts runCheck), and the
 * block raises nothing; then, with an element of a declaring kind no declaration names, it raises SQLSTATE 23000 under
 * the law's identity. The oracle is the bound itself, rows counted over every loop, never a clock.
 *
 * The box, exhausted: the rule of QTI's __node_kind_in_declaration's shape, Node's elements of a declaring kind
 * contained in Decl on (pkg, path, at), over two layouts of the elements at six sizes from 500 to 16,000, each twice the
 * one before, the tables analyzed, as a migration's are by the runbook and autovacuum: the sizes at which a first-row
 * plan of the check is a nested loop differ by layout, and the box holds some for each.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type CheckFeature,
	checkCaseGen,
	checkCostTemplate,
	runCheck
} from "#test/pg/laws/check-cost.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A law's full check reads each row it checks a bounded number of times, finds nothing where the law holds, and refuses an undeclared element under the law's identity. */
export const aLawsFullCheckReadsEachRowItChecksABoundedNumberOfTimesAndRefusesAViolationUnderTheLawsIdentity =
	property.exhaust(finite(checkCaseGen), {
		needs: { ledger: Substrate.rolledBack(checkCostTemplate) },
		situations: ["a law that holds", "a violation found"] satisfies ReadonlyArray<
			Reached<CheckFeature>
		>,
		check:
			({ ledger }, k) =>
			(c) =>
				Effect.flatMap(ledger, ({ connection, value }) => runCheck(value, connection, c, k)),
		oracle: {
			kind: "specification",
			name: "the bound: every plan of the check touches at most its nodes times the rows of the tables it reads, counted over all loops; and SQLSTATE 23000 under the law's identity for an undeclared element"
		},
		box: "the rule Node's elements of a declaring kind contained in Decl on (pkg, path, at), two layouts at 500, 1,000, 2,000, 4,000, 8,000 and 16,000 elements, analyzed",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/build.ts",
				original:
					'): PlStatement => ({\n\tkind: "whenFound",\n\tprobe: {\n\t\tbody: core(\n\t\t\t[target(lit.int(1, types.integer))],\n\t\t\t[derived(query, "found", [], false)],\n\t\t\tundefined\n\t\t),\n\t\torderBy: [],\n\t\tlimit: undefined,\n\t\toffset: undefined\n\t},\n\tbody\n})',
				replacement:
					'): PlStatement => ({ kind: "if", branches: [{ condition: exists(query), body }], else: [] })',
				why: "A check asks IF EXISTS of its violation query, which PostgreSQL plans for its first row: a nested loop over the target's materialized rows for each source row, run to its end where the law holds."
			}
		]
	})
