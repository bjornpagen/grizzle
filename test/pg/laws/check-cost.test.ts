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
 * A law over a stored relation alone is held by its table's natives (physical/ddl/rules.ts upkeepBlock): a key is the
 * table's unique index, which the migration that creates the table builds before it fills it (deploy/diff/diff.ts
 * view), so that law's migration has no check of its own, and its cost is the fill's, INSERT INTO the table of every row
 * of its definition (physical/derived/objects.ts fillStatement), a query PostgreSQL plans as it plans a check. It is held
 * to the same bound.
 *
 * Property: for each case of the box, no SELECT DISTINCT of a check's query or of a fill's reads only sets whose every
 * column its targets keep (check-cost.fixtures.ts needlessDeduplications), and every statement a stored relation's fill
 * runs and a check's block plans, explained with ANALYZE as PL/pgSQL plans it, reads each table by at most one plan node
 * per occurrence its law or its definition reads it at, as the box declares its sides and the rules of the relations
 * they read, never as the compiled check reads them, and the check over every row reads no region beside them (WholeRule
 * everyRow), and touches at most its plan's nodes times the rows of the tables (runCheck), and the fill and the block
 * raise nothing; then, with an element of a declaring kind no declaration names, two declared elements of one document
 * and kind that share a weight, a name declared at two places of one document with two cardinalities, and a binding of
 * attribute 1 to a variable of base type 2, each block raises SQLSTATE 23000 under its law's identity, and the fill
 * raises 23505 under its key's, the constraint the installation maps to the key (ir/products.ts lawsOfConstraint). The
 * oracle is the bound itself, rows counted over every loop and scans counted per table, never a clock.
 *
 * The box, exhausted: four rules of QTI's shapes, Node's elements of a declaring kind contained in Decl on
 * (pkg, path, at), its elements of tag, group and band 5, three columns every element holds alike, the key over
 * CardName of document and name, each declared name beside its cardinality with its place projected away, and the
 * check over Fit, each binding beside its declaration's cardinality and base type, of two derived relations that each
 * witness the declaration's place, and the key over Node ⋈ Decl of document, kind and weight, which Declared's table
 * holds by its unique index, Declared delivering its document's unit at each place, over two layouts of the elements at
 * six sizes from 500 to 16,000, each twice the one before, the tables analyzed, as a migration's are by the runbook and
 * autovacuum.
 *
 * A fill derives its relation whole, every row of every table it reads, so its bound is the rows of those tables, each
 * read a bounded number of times by a lookup of what the steps before it bound: O(n log n). pantry's namingRecords
 * (qti/queries.ts), each record under a resource's metadata with the document the resource's `href` lists, filled on
 * edullm's QTI copy in 452.2 s over 0 rows, 656,026,169 buffers: R02 had made existence tests of the metadata element
 * and the `href`, the only occurrences relating the record to its resource and the resource to its document, so the
 * fill joined each record to every typed resource of its manifest and each to every listed document of its package by
 * the package alone. R02 keeps both in the region (existence/index.ts keepsRestriction, demand/restriction.ts
 * linkedColumns): each relates a record to the rest of it at a column no other occurrence does. Held in a flat join,
 * PostgreSQL's estimates still joined each record to every typed resource of its manifest by the manifest alone, a
 * prefix of each key that every row of the manifest shares, and probed each metadata element by the manifest alone
 * after: 672,128 rows touched at 64 resources. The region nothing binds is read from its root (cte-policy rootChain,
 * share/sites.ts regionChain): every record read where it stands, its metadata element, the `href` and the type of its
 * resource each a seek of its key at the values of the rows before it, the records' n rows each with one row of every
 * other, O(n log n).
 *
 * Property: for each case of the second box, Named's fill, explained with ANALYZE, reads each table by at most one plan
 * node per occurrence its definition reads it at, and touches at most its plan's nodes times the rows of the tables,
 * and holds each record whose resource is of an object's type and whose `href` names a listed document. The box,
 * exhausted: namingRecords' rule over a package sealed at its founding, its manifest's elements, records, attributes,
 * `href`s and listed documents keyed as pantry's are, every resource typed, resolved and listed or every third
 * unresolved, every fifth of no object's type and every seventh naming no listed document, in one package and in four,
 * of 16, 64 and 256 resources each, the tables analyzed. The resource types, a closed sub-query over the sealed
 * package's content, are a canonical relation the installation stores, filled before Named and held to the same bound.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type CheckFeature,
	checkCaseGen,
	checkCostTemplate,
	type NamingFeature,
	namingCaseGen,
	namingFillTemplate,
	runCheck,
	runNamingFill
} from "#test/pg/laws/check-cost.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A law's full check, or the fill of the stored relation whose natives hold it, reads each table once per occurrence and each row a bounded number of times, deduplicates no set, finds nothing where the law holds, and refuses a violation under the law's identity. */
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
			name: "the bound: no deduplication of a set, and every plan of a check or a stored relation's fill reads each table by one node per occurrence its law or definition reads it at as the box declares it, and touches at most its nodes times the rows of the tables it reads, counted over all loops; and SQLSTATE 23000 under the law's identity for an undeclared element, a name of two cardinalities and a binding of a type its attribute refuses, and 23505 under the key's for two declared elements at one key"
		},
		box: "the rules Node's elements of a declaring kind, and of tag, group and band 5, contained in Decl on (pkg, path, at), CardName keyed by (pkg, path, ident), and a check over Bind ⋈ CardName ⋈ TypedName, and the stored Declared, Node ⋈ Decl keyed by (pkg, path, kind, w), filled, two layouts at 500, 1,000, 2,000, 4,000, 8,000 and 16,000 elements, analyzed",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/snapshot/violation.ts",
				original: "\t\t\t\tquery: defined(\n\t\t\t\t\tinstallation.ruleChecks.get(r.law.id),",
				replacement:
					"\t\t\t\tquery: checkOf(installation, violations, stated, r.law.id).query ?? defined(\n\t\t\t\t\tinstallation.ruleChecks.get(r.law.id),",
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
			},
			{
				file: "packages/engine/src/physical/derived/objects.ts",
				original: "\tquery: create.query\n})",
				replacement:
					'\tquery: { ...create.query, body: { kind: "setOp", op: "UNION", arms: [create.query, create.query] } }\n})',
				why: "A stored relation's fill derives its definition twice, the definition's union with itself: each table it reads by a scan of each derivation, and every row it derives hashed or sorted against the other's, where the fill reads each table once per occurrence its definition reads it at."
			}
		]
	})

/**
 * The fill of a stored relation of pantry's namingRecords' shape, each record under a resource's metadata with the
 * document the resource's `href` lists, reads each table once per occurrence and touches each row a bounded number of
 * times, O(n log n) in its records, elements, attributes and documents, and fills each record that names a document.
 */
export const aFillOfNamingRecordsShapeReadsEachRecordElementAttributeAndDocumentABoundedNumberOfTimes =
	property.exhaust(finite(namingCaseGen), {
		needs: { manifest: Substrate.rolledBack(namingFillTemplate) },
		situations: [
			"a record that names its document",
			"a record that names none"
		] satisfies ReadonlyArray<Reached<NamingFeature>>,
		check:
			({ manifest }, k) =>
			(c) =>
				Effect.flatMap(manifest, ({ connection, value }) => runNamingFill(value, connection, c, k)),
		oracle: {
			kind: "specification",
			name: "the bound: the fill's plan reads each table by one node per occurrence its definition reads it at, and touches at most its nodes times the rows of the tables, counted over all loops; and it holds each record whose resource's type is an object's and whose href names a listed document"
		},
		box: "Named, namingRecords' rule over a sealed package's manifest elements, records, attributes, hrefs and listed documents, stored and filled: every resource typed, resolved and listed, or every third unresolved, every fifth of no object's type and every seventh naming no listed document, in one package and in four, of 16, 64 and 256 resources each, analyzed",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/existence/index.ts",
				original: "\t\tconst keeping = connected.filter((o) => keepsRestriction(node, o))\n",
				replacement: "\t\tconst keeping = connected\n",
				why: "R02 makes existence tests of the metadata element and the href, as before: the fill joins each record to every typed resource of its document and each to every listed document of its package by the package alone, the two tests applied to the product, as edullm's QTI copy's namingRecords fill read 656,026,169 buffers for its 0 rows."
			},
			{
				file: "packages/engine/src/lower/shapes/share/sites.ts",
				original: "\t\t: rootChain(region, region.occurrences)\n",
				replacement: "\t\t: undefined\n",
				why: "A region nothing binds is joined by PostgreSQL's estimates: it joins each record to every typed resource of its manifest by the manifest alone and probes each metadata element by the manifest alone after, 672,128 rows touched at 64 resources."
			}
		]
	})
