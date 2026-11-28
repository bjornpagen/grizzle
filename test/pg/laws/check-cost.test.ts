/**
 * A law's full check, as the migration that adds or changes a rule runs it over every row (deploy/render/sql.ts, a bound
 * violation check), and a stored relation's fill, as the migration that creates its table runs it (physical/derived/
 * objects.ts fillStatement), read each row of the tables they read a bounded number of times, on PostgreSQL 19, in every
 * state pg_class leaves a table in: each runs under the plan advice its migration file carries (deploy/render/advise.ts,
 * its data steps bound under its transaction's one scope, the plans joined into the advice meta.json records), which the
 * runner sets as the file's transaction's first statement (LedgerStatements `advise`), so no estimate chooses a plan.
 *
 * edullm's QTI cutover of 547 law checks ran 766.8 s on a production-scale copy, 284 s of it one check and 190 s
 * another, each asked as IF EXISTS (<violation query>): PostgreSQL plans an EXISTS sublink for its first row, like a
 * LIMIT 1 (src/backend/optimizer/plan/subselect.c make_subplan), and expects violations, so it chose a nested loop
 * over the target's materialized rows for each source row: __node_kind_in_declaration's removed 1,806,876,555 pairs by
 * its join filter, 366.8 s. A key's check over a derived relation was a self-join of its side, which derived the side
 * twice: __choice_node_key_package_path_kind_identifier's took 32.2 s. And follow-up 4's S5 spent 354 s of its 801.8 s
 * window on the binding-fit checks, which read each derived relation of BindingBaseTypeNode as a query of its own,
 * SELECT DISTINCT over a join that witnesses the declaration's place, joined to the next by PostgreSQL's estimate of
 * each: 102 rows of 61,093, a nested loop that threw 1,165,329,900 pairs away over zero violations. A plan that rests on
 * estimates is the bug; the plan grizzle proves is carried as advice, and each relation is read by a lookup of what the
 * steps before it bound, or whole beside a hash, which no estimate reorders.
 *
 * A law over a stored relation alone is held by its table's natives (physical/ddl/rules.ts upkeepBlock): a key is the
 * table's unique index and a check its CHECK constraint, which the migration that creates the table builds before it
 * fills it (deploy/diff/diff.ts view), so that law's migration has no check of its own, and its cost is the fill's,
 * INSERT INTO the table of every row of its definition, held to the same bound.
 *
 * Property: for each case of the box, in each pg_class state (test/support/advice.ts PgClassState: never vacuumed,
 * counted empty, analyzed, skewed, large), every data step of the template's migration, each stored relation's fill and
 * each rule's check, as the migration's files hold them bound (deploy/render/advise.ts AdvisedFile): the plan laws hold
 * over each file's steps under the advice the runner sets from its record (advice.ts lawsHold, Laws 1 to 3); no SELECT
 * DISTINCT of a step reads only sets whose every column its targets keep (check-cost.fixtures.ts needlessDeduplications);
 * and each step, run under that advice with EXPLAIN ANALYZE, keeps its plan's budget (advice.ts budgetOfPlan), reads
 * each table by at most one plan node per occurrence its law or its definition reads it at, as the box declares its
 * sides and the rules of the relations they read, never as the compiled check reads them, and touches at most its plan's
 * nodes times the rows of the tables it reads (holdsTheBound), the fills and the checks raising nothing; then each law
 * broken alone, an element of a declaring kind and of tag, group and band 5 that no declaration names, two declared
 * elements of one document and kind that share a weight, a name declared at two places of one document with two
 * cardinalities, and a binding of attribute 1 to a variable of base type 2, is refused with SQLSTATE class 23 by the
 * steps that hold it alone, each under the identity of its laws: each check's block under its law's, and the fills of
 * Declared, CardName and Fit under their natives', the constraint the installation maps to each (ir/products.ts
 * lawsOfConstraint). The oracle is the bound itself, rows counted over every loop, scans counted per table and pages
 * per scan, never a clock.
 *
 * The box, exhausted: four rules of QTI's shapes, Node's elements of a declaring kind contained in Decl on
 * (pkg, path, at), its elements of tag, group and band 5, three columns every element holds alike, the key over
 * CardName of document and name, each declared name beside its cardinality with its place projected away, and the
 * check over Fit, each binding beside its declaration's cardinality and base type, of two derived relations that each
 * witness the declaration's place, and the key over Node ⋈ Decl of document, kind and weight, Declared delivering its
 * document's unit at each place, the installation storing every derived relation of it, over two layouts of the
 * elements at six sizes from 500 to 16,000, each twice the one before.
 *
 * A fill derives its relation whole, every row of every table it reads, so its bound is the rows of those tables, each
 * read a bounded number of times by a lookup of what the steps before it bound: O(n log n). pantry's namingRecords
 * (qti/queries.ts), each record under a resource's metadata with the document the resource's `href` lists, filled on
 * edullm's QTI copy in 452.2 s over 0 rows, 656,026,169 buffers: R02 had made existence tests of the metadata element
 * and the `href`, the only occurrences relating the record to its resource and the resource to its document, so the
 * fill joined each record to every typed resource of its manifest and each to every listed document of its package by
 * the package alone. R02 keeps both in the region (existence/index.ts keepsRestriction, demand/restriction.ts
 * linkedColumns): each relates a record to the rest of it at a column no other occurrence does, and the fill reads
 * every record where it stands, its metadata element, the `href` and the type of its resource each a seek of its key at
 * the values of the rows before it, the records' n rows each with one row of every other, O(n log n), under the advice
 * its file carries.
 *
 * Property: for each case of the second box, in each pg_class state, the fills of the template's migration, the resource
 * types' canonical relation's and Named's, hold the plan laws under the advice the runner sets, keep their budget, read
 * each table by at most one plan node per occurrence their definition reads it at, and touch at most their plan's nodes
 * times the rows of the tables, and Named's holds each record whose resource is of an object's type and whose `href`
 * names a listed document. The box, exhausted: namingRecords' rule over a package sealed at its founding, its
 * manifest's elements, records, attributes, `href`s and listed documents keyed as pantry's are, every resource typed,
 * resolved and listed or every third unresolved, every fifth of no object's type and every seventh naming no listed
 * document, in one package and in four, of 16, 64 and 256 resources each. The resource types, a closed sub-query over
 * the sealed package's content, are a canonical relation the installation stores, filled before Named and held to the
 * same bound.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
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
import { pgClassStates } from "#test/support/advice.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A law's full check, or the fill of the stored relation whose natives hold it, run under its migration file's advice in every pg_class state, holds the plan laws and its budget, reads each table once per occurrence and each row a bounded number of times, deduplicates no set, finds nothing where the law holds, and refuses a violation under the law's identity. */
export const aLawsFullCheckReadsEachTableOncePerOccurrenceAndEachRowABoundedNumberOfTimesDeduplicatesNoSetAndRefusesAViolationUnderTheLawsIdentity =
	property.exhaust(finite(checkCaseGen), {
		needs: { ledger: Substrate.rolledBack(checkCostTemplate) },
		situations: [
			"a law that holds",
			"a violation found",
			...Arr.map(pgClassStates, (state) => `every table ${state}` as const)
		] satisfies ReadonlyArray<Reached<CheckFeature>>,
		check:
			({ ledger }, k) =>
			(c) =>
				Effect.flatMap(ledger, (clone) => runCheck(clone, c, k)),
		oracle: {
			kind: "specification",
			name: "the plan laws over each migration file's data steps under the advice the runner sets, and the bound: no deduplication of a set, and every plan of a check or a stored relation's fill keeps its budget, reads each table by one node per occurrence its law or definition reads it at as the box declares it, and touches at most its nodes times the rows of the tables it reads, counted over all loops, in every pg_class state; and SQLSTATE class 23 from the steps that hold each law broken alone, under its laws' identity: each check's for an undeclared element, Declared's key's for two declared elements at one key, CardName's for a name of two cardinalities and Fit's check's for a binding of a type its attribute refuses"
		},
		box: "the rules Node's elements of a declaring kind, and of tag, group and band 5, contained in Decl on (pkg, path, at), CardName keyed by (pkg, path, ident), and a check over Bind ⋈ CardName ⋈ TypedName, and Declared, Node ⋈ Decl keyed by (pkg, path, kind, w), every derived relation stored and filled, two layouts at 500, 1,000, 2,000, 4,000, 8,000 and 16,000 elements, in every pg_class state",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/render/advise.ts",
				original: '\t\t\tplanned(bound.plan)\n\t\t\treturn { kind: "step"',
				replacement: '\t\t\treturn { kind: "step"',
				why: "A stored relation's fill runs under no advice: its plan is joined into no file's advice, so meta.json records none for the fills' file and the runner sets none. Law 1 refuses it in every state, the vehicle holding none of the atoms the fills carry and each fill planned under none; and the fills' bound alone refuses it with every table counted empty, where PostgreSQL's costs make Declared's fill a nested loop that scans Decl whole for each element, 126,000 rows touched at 500 elements, past its 4 nodes times the 750 rows it reads, and Named's 1,536 at 16 resources, past 12 times 112."
			},
			{
				file: "packages/engine/src/deploy/snapshot/violation.ts",
				original: "\t\t\t\tquery: defined(\n\t\t\t\t\tinstallation.ruleChecks.get(r.law.id),",
				replacement:
					"\t\t\t\tquery: checkOf(installation, violations, stated, r.law.id).query ?? defined(\n\t\t\t\t\tinstallation.ruleChecks.get(r.law.id),",
				why: "A rule's check is its violation query lowered by the oracle baseline again, each relation it reads a query of its own: the containment's check deduplicates a set again, a SELECT DISTINCT over a derived table of a set whose every column it keeps, a sort or hash of every element its side reads, where the side is read once."
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
 * document the resource's `href` lists, run under its migration file's advice in every pg_class state, holds the plan
 * laws and its budget, reads each table once per occurrence and touches each row a bounded number of times, O(n log n)
 * in its records, elements, attributes and documents, and fills each record that names a document.
 */
export const aFillOfNamingRecordsShapeReadsEachRecordElementAttributeAndDocumentABoundedNumberOfTimes =
	property.exhaust(finite(namingCaseGen), {
		needs: { manifest: Substrate.rolledBack(namingFillTemplate) },
		situations: [
			"a record that names its document",
			"a record that names none",
			...Arr.map(pgClassStates, (state) => `every table ${state}` as const)
		] satisfies ReadonlyArray<Reached<NamingFeature>>,
		check:
			({ manifest }, k) =>
			(c) =>
				Effect.flatMap(manifest, (clone) => runNamingFill(clone, c, k)),
		oracle: {
			kind: "specification",
			name: "the plan laws over the fills under the advice the runner sets, and the bound: each fill's plan keeps its budget, reads each table by one node per occurrence its definition reads it at, and touches at most its nodes times the rows of the tables, counted over all loops, in every pg_class state; and Named's holds each record whose resource's type is an object's and whose href names a listed document"
		},
		box: "Named, namingRecords' rule over a sealed package's manifest elements, records, attributes, hrefs and listed documents, stored and filled: every resource typed, resolved and listed, or every third unresolved, every fifth of no object's type and every seventh naming no listed document, in one package and in four, of 16, 64 and 256 resources each, in every pg_class state",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/existence/index.ts",
				original: "\t\tconst keeping = connected.filter((o) => keepsRestriction(node, o))\n",
				replacement: "\t\tconst keeping = connected\n",
				why: "R02 makes existence tests of the metadata element and the href, as before: the fill joins each record to every typed resource of its document and each to every listed document of its package by the package alone, the two tests applied to the product, as edullm's QTI copy's namingRecords fill read 656,026,169 buffers for its 0 rows."
			}
		]
	})
