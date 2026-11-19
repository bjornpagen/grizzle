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
 * Read whole, a containment's NOT EXISTS was still a nested loop wherever PostgreSQL underestimated its source:
 * __attribute_lexical_document_type_kind_name_in, its name, kind and document type estimated at one row of 15,035,
 * removed 113,018,095 pairs in 25.6 s. A containment's check is its source less its target, EXCEPT, which PostgreSQL
 * computes by hashing or sorting each side once (lower/conservative/anti-join exceptOf), under a whole plan and under a
 * first-row plan alike, so this box no longer tells the check's IF EXISTS from its PERFORM, and no box does: the
 * judge's statements, which ask the same (sql/build.ts whenFound), plan alike in both forms. A key's check over a
 * derived relation was a self-join of its side, each fact met by another that agrees with it on the key and differs
 * elsewhere, which derived the side twice: __choice_node_key_package_path_kind_identifier's, choice ⋈ node, took
 * 32.2 s of the series' 320.7 s on that copy. It is the side read once, grouped by the key, its facts counted
 * (analysis/theory/query.ts violationQuery), so it reads each table once.
 *
 * Property: for each case of the box, every statement the check's block plans, explained with ANALYZE as PL/pgSQL
 * plans it, reads each table by one plan node and touches at most its plan's nodes times the rows of the two tables
 * (check-cost.fixtures.ts runCheck), and the block raises nothing; then, with an element of a declaring kind no
 * declaration names and two declared elements of one document and kind that share a weight, it raises SQLSTATE 23000
 * under the law's identity. The oracle is the bound itself, rows counted over every loop and scans counted per table,
 * never a clock.
 *
 * The box, exhausted: the rules of QTI's three shapes, Node's elements of a declaring kind contained in Decl on
 * (pkg, path, at), its elements of tag, group and band 5, three columns every element holds alike, and the key over
 * Node ⋈ Decl of document, kind and weight, over two layouts of the elements at six sizes from 500 to 16,000, each
 * twice the one before, the tables analyzed, as a migration's are by the runbook and autovacuum: the sizes at which a
 * first-row plan of the first rule's check, or a whole plan of the second's NOT EXISTS, is a nested loop differ by
 * layout, and the box holds some for each.
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

/** A law's full check reads each table it checks once and each row a bounded number of times, finds nothing where the law holds, and refuses a violation under the law's identity. */
export const aLawsFullCheckReadsEachTableOnceAndEachRowABoundedNumberOfTimesAndRefusesAViolationUnderTheLawsIdentity =
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
			name: "the bound: every plan of the check reads each table by one node and touches at most its nodes times the rows of the tables it reads, counted over all loops; and SQLSTATE 23000 under the law's identity for an undeclared element and for two declared elements at one key"
		},
		box: "the rules Node's elements of a declaring kind, and of tag, group and band 5, contained in Decl on (pkg, path, at), and Node ⋈ Decl keyed by (pkg, path, kind, w), two layouts at 500, 1,000, 2,000, 4,000, 8,000 and 16,000 elements, analyzed",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/anti-join/index.ts",
				original: "\treturn pairs !== undefined && isNonEmpty(pairs)",
				replacement: "\treturn pairs === undefined && isNonEmpty([])",
				why: "A containment's check is NOT EXISTS again, which PostgreSQL plans, for a source of three correlated columns it estimates at a row or two, as a nested loop over the target for each source row."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: `\t\t\tconst side = wholeSide(rule.side, definition, rule.side.heading, "s0.", loc)\n`,
				replacement: `\t\t\tconst heading = rule.side.heading\n\t\t\tconst one = wholeSide(rule.side, definition, heading, "s0.", loc)\n\t\t\tconst other = wholeSide(rule.side, definition, heading, "s1.", loc)\n\t\t\tconst otherFacts = imported(\n\t\t\t\t[\n\t\t\t\t\truleDesc(\n\t\t\t\t\t\tother.vars,\n\t\t\t\t\t\t[other.match],\n\t\t\t\t\t\tother.where,\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\t...termHead(other.terms),\n\t\t\t\t\t\t\t...Object.fromEntries(\n\t\t\t\t\t\t\t\theading.map((f) => [headName(f), wholeField(other, f, loc)] as const)\n\t\t\t\t\t\t\t)\n\t\t\t\t\t\t},\n\t\t\t\t\t\tloc\n\t\t\t\t\t)\n\t\t\t\t],\n\t\t\t\tloc\n\t\t\t)\n\t\t\tconst bindings: Record<string, InferredExpr> = { ...termHead(one.terms) }\n\t\t\tfor (const f of heading) {\n\t\t\t\tbindings[headName(f)] = varRef(otherId(f))\n\t\t\t}\n\t\t\treturn queryOf(\n\t\t\t\t[\n\t\t\t\t\truleDesc(\n\t\t\t\t\t\t[...one.vars, ...heading.map((f) => ({ id: otherId(f), origin: undefined, loc }))],\n\t\t\t\t\t\t[one.match, { source: otherFacts, bindings, loc }],\n\t\t\t\t\t\t[\n\t\t\t\t\t\t\t...one.where,\n\t\t\t\t\t\t\tconnectiveExpr(\n\t\t\t\t\t\t\t\t"or",\n\t\t\t\t\t\t\t\theading.map((f): InferredExpr => ({\n\t\t\t\t\t\t\t\t\tkind: "compare",\n\t\t\t\t\t\t\t\t\top: "ne",\n\t\t\t\t\t\t\t\t\tleft: wholeField(one, f, loc),\n\t\t\t\t\t\t\t\t\tright: varRef(otherId(f))\n\t\t\t\t\t\t\t\t}))\n\t\t\t\t\t\t\t)\n\t\t\t\t\t\t],\n\t\t\t\t\t\ttermHead(one.terms),\n\t\t\t\t\t\tloc\n\t\t\t\t\t)\n\t\t\t\t],\n\t\t\t\tloc\n\t\t\t)\n\t\t\tconst side = wholeSide(rule.side, definition, rule.side.heading, "s0.", loc)\n`,
				why: "A key's check is the self-join of its side again, a fact of the side met by another that agrees with it on the key and differs from it elsewhere, which derives the side twice, each relation it reads by a scan of each derivation."
			}
		]
	})
