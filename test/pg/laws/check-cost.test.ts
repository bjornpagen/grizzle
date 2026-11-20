/**
 * A law's full check, as the migration that adds or changes a rule runs it over every row (deploy/render/sql.ts
 * violationCheck), reads each row of the tables it checks a bounded number of times, on PostgreSQL 19: a rule's check
 * is its judge over the transaction that writes every row (deploy/snapshot/violation.ts lawChecks, physical/ddl/rules.ts
 * addRules), one chain of lookups from its region, whatever PostgreSQL estimates.
 *
 * edullm's QTI cutover of 547 law checks ran 766.8 s on a production-scale copy, 284 s of it one check and 190 s
 * another, each asked as IF EXISTS (<violation query>): PostgreSQL plans an EXISTS sublink for its first row, like a
 * LIMIT 1 (src/backend/optimizer/plan/subselect.c make_subplan), and expects violations, so it chose a nested loop
 * over the target's materialized rows for each source row: __node_kind_in_declaration's removed 1,806,876,555 pairs by
 * its join filter, 366.8 s. A key's check over a derived relation was a self-join of its side, which derived the side
 * twice: __choice_node_key_package_path_kind_identifier's took 32.2 s. It is the side read once, grouped by the key, its
 * facts counted (analysis/theory/query.ts violationQuery). And follow-up 4's S5 spent 354 s of its 801.8 s window on the
 * binding-fit checks, which read each derived relation of BindingBaseTypeNode as a query of its own, SELECT DISTINCT
 * over a join that witnesses the declaration's place, joined to the next by PostgreSQL's estimate of each: 102 rows of
 * 61,093, a nested loop that threw 1,165,329,900 pairs away over zero violations. With no ANALYZE and no planner setting
 * of grizzle's own, a plan that rests on estimates is the bug; the judge's chain (analysis/theory/navigate.ts) reads
 * each relation by a lookup of what the steps before it bound, which no estimate reorders.
 *
 * Property: for each case of the box, no SELECT DISTINCT of a check's query reads only sets whose every column its
 * targets keep (check-cost.fixtures.ts needlessDeduplications), and every statement the check's block plans, explained
 * with ANALYZE as PL/pgSQL plans it, reads each table by at most one plan node per occurrence its law reads it at, as
 * the box declares its sides and the rules of the relations they read, never as the compiled check reads them, and the
 * check over every row reads no region beside them (WholeRule everyRow), and touches at most its plan's nodes times the
 * rows of the tables (runCheck), and the
 * block raises nothing; then, with an element of a declaring kind no declaration names, two declared elements of one
 * document and kind that share a weight, and a binding of attribute 1 to a variable of base type 2, it raises SQLSTATE
 * 23000 under the law's identity. The oracle is the bound itself, rows counted over every loop and scans counted per
 * table, never a clock.
 *
 * The box, exhausted: the rules of QTI's four shapes, Node's elements of a declaring kind contained in Decl on
 * (pkg, path, at), its elements of tag, group and band 5, three columns every element holds alike, the key over
 * Node ⋈ Decl of document, kind and weight, and the check over Fit, each binding beside its declaration's cardinality
 * and base type, of two derived relations that each witness the declaration's place, over two layouts of the elements
 * at six sizes from 500 to 16,000, each twice the one before, the tables analyzed, as a migration's are by the runbook
 * and autovacuum.
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

/** A law's full check reads each table once per occurrence and each row a bounded number of times, deduplicates no set, finds nothing where the law holds, and refuses a violation under the law's identity. */
export const aLawsFullCheckReadsEachTableOncePerOccurrenceAndEachRowABoundedNumberOfTimesDeduplicatesNoSetAndRefusesAViolationUnderTheLawsIdentity =
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
			name: "the bound: no deduplication of a set, and every plan of the check reads each table by one node per occurrence its law reads it at as the box declares it, and touches at most its nodes times the rows of the tables it reads, counted over all loops; and SQLSTATE 23000 under the law's identity for an undeclared element, two declared elements at one key and a binding of a type its attribute refuses"
		},
		box: "the rules Node's elements of a declaring kind, and of tag, group and band 5, contained in Decl on (pkg, path, at), Node ⋈ Decl keyed by (pkg, path, kind, w), and a check over Bind ⋈ CardName ⋈ TypedName, two layouts at 500, 1,000, 2,000, 4,000, 8,000 and 16,000 elements, analyzed",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/snapshot/violation.ts",
				original: "\t\t\t\tquery: defined(\n\t\t\t\t\tinstallation.ruleChecks.get(r.law.id),",
				replacement:
					"\t\t\t\tquery: checkOf(installation, violations, r.law.id).query ?? defined(\n\t\t\t\t\tinstallation.ruleChecks.get(r.law.id),",
				why: "A rule's check is its violation query lowered by the oracle baseline again, each derived relation a query of its own joined to the next by PostgreSQL's estimates: Fit's two derived relations, each underestimated by its join's correlated columns, are joined by a nested loop over one's rows for each of the other's, as follow-up 4's binding-fit checks were."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: `\t\t\tconst side = wholeSide(rule.side, live, rule.side.heading, "s0.", loc)\n`,
				replacement: `\t\t\tconst heading = rule.side.heading\n\t\t\tconst one = wholeSide(rule.side, live, heading, "s0.", loc)\n\t\t\tconst other = wholeSide(rule.side, live, heading, "s1.", loc)\n\t\t\tconst otherFacts = imported(\n\t\t\t\t[\n\t\t\t\t\truleDesc(\n\t\t\t\t\t\tother.vars,\n\t\t\t\t\t\t[other.match],\n\t\t\t\t\t\tother.where,\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\t...termHead(other.terms),\n\t\t\t\t\t\t\t...Object.fromEntries(\n\t\t\t\t\t\t\t\theading.map((f) => [headName(f), wholeField(other, f, loc)] as const)\n\t\t\t\t\t\t\t)\n\t\t\t\t\t\t},\n\t\t\t\t\t\tloc\n\t\t\t\t\t)\n\t\t\t\t],\n\t\t\t\tloc\n\t\t\t)\n\t\t\tconst bindings: Record<string, InferredExpr> = { ...termHead(one.terms) }\n\t\t\tfor (const f of heading) {\n\t\t\t\tbindings[headName(f)] = varRef(otherId(f))\n\t\t\t}\n\t\t\treturn queryOf(\n\t\t\t\t[\n\t\t\t\t\truleDesc(\n\t\t\t\t\t\t[...one.vars, ...heading.map((f) => ({ id: otherId(f), origin: undefined, loc }))],\n\t\t\t\t\t\t[one.match, { source: otherFacts, bindings, loc }],\n\t\t\t\t\t\t[\n\t\t\t\t\t\t\t...one.where,\n\t\t\t\t\t\t\tconnectiveExpr(\n\t\t\t\t\t\t\t\t"or",\n\t\t\t\t\t\t\t\theading.map((f): InferredExpr => ({\n\t\t\t\t\t\t\t\t\tkind: "compare",\n\t\t\t\t\t\t\t\t\top: "ne",\n\t\t\t\t\t\t\t\t\tleft: wholeField(one, f, loc),\n\t\t\t\t\t\t\t\t\tright: varRef(otherId(f))\n\t\t\t\t\t\t\t\t}))\n\t\t\t\t\t\t\t)\n\t\t\t\t\t\t],\n\t\t\t\t\t\ttermHead(one.terms),\n\t\t\t\t\t\tloc\n\t\t\t\t\t)\n\t\t\t\t],\n\t\t\t\tloc\n\t\t\t)\n\t\t\tconst side = wholeSide(rule.side, live, rule.side.heading, "s0.", loc)\n`,
				why: "A key's check is the self-join of its side again, a fact of the side met by another that agrees with it on the key and differs from it elsewhere, which derives the side twice, each relation it reads by a scan of each derivation."
			},
			{
				file: "packages/engine/src/lower/shapes/index.ts",
				original: '\t\treturn facts.realization(node) === "plain"\n',
				replacement: "\t\treturn facts.realization(node) !== facts.realization(node)\n",
				why: "A node the placement realizes plain keeps its DISTINCT, so every filter, renaming and region over a set deduplicates again: the DISTINCT tower, a sort or hash of every row of node at each level of QTI's checks."
			}
		]
	})
