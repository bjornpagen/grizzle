/**
 * A rule's judge reads every relation a join it reads holds by the columns the rows before it bound, a derived
 * relation's definition included, under a negation or not (analysis/theory/navigate.ts navigateQuery, which
 * physical/ddl/rules.ts judgedStatement runs on every query the judge reads): never a join under its correlation alone,
 * which PostgreSQL may read as a product it filters afterwards. On PostgreSQL 19, over ProbedBinding and WholeBinding
 * (rule-binding.fixtures.ts), qti's nodes, dependencies and resource ids and two of its rules' shapes: "Dependency
 * target", a containment of Ref into the derived join of Ref, its node and the resource its ref names, and "Document
 * lang"'s join within a document, a containment of the derived join of Named and its node into Node; probed, the
 * relations mutable, or judged whole.
 *
 * edullm's g3-1, published first into tables no ANALYZE had run on, spent 1 h 46 min (PUBLISHPERF) and 2,041 s
 * (PRODLAB) in its COMMIT before it was killed, in one statement, __rule_dependency_in_dependency_resolved: its negation
 * of DependencyResolved at each dependency's (package, path, start), read as written, joined qti.node and
 * qti.resource_id at (package, path) alone, every read estimated at one row, so PostgreSQL nested the dependencies of
 * imsmanifest.xml, its 4,132 nodes and 480 resource ids inside the anti join once for each of its 420 dependencies.
 *
 * Property: for each case of the box, every statement the judge runs of either rule, explained with ANALYZE as PL/pgSQL
 * plans it, touches at most its plan's nodes times the rows the transaction wrote (rule-binding.fixtures.ts runBinding):
 * a lookup a node a row written, whatever PostgreSQL estimates. The oracle is the bound, rows counted over every loop,
 * never a clock.
 *
 * The box, exhausted: both judgments, one and three documents of 64, 128 and 256 nodes written beside 40 stored, with no
 * statistics and analyzed.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type BindingFeature,
	bindingGen,
	bindingTemplates,
	runBinding
} from "#test/pg/laws/rule-binding.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A rule's judge reads each relation a join it reads holds by a lookup a row written, with statistics or none. */
export const aRulesJudgeReadsEachRelationAJoinItReadsHoldsByALookupARowWrittenWithStatisticsOrNone =
	property.exhaust(finite(bindingGen), {
		needs: Substrate.oneOf(bindingTemplates, Substrate.rolledBack),
		situations: [
			"a probed rule's negated join",
			"a whole rule's negated join",
			"a whole rule's join within a unit",
			"planned with no statistics",
			"planned analyzed"
		] satisfies ReadonlyArray<Reached<BindingFeature>>,
		check: (templates, c) => (drawn) =>
			Effect.gen(function* () {
				const { connection, value } = yield* templates[`${drawn.judged} ${drawn.nodes}`]
				yield* runBinding(value, connection, drawn, c)
			}),
		oracle: {
			kind: "universal",
			name: "bound: every statement the judge runs touches at most its plan's nodes times the rows the transaction wrote, counted over all loops"
		},
		box: "both judgments, one and three documents of 64, 128 and 256 nodes beside 40 stored, with no statistics and analyzed",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\treads.one !== undefined && (reads.one > 1 || reads.filtersJoin)",
				replacement: "\treads.one !== undefined && reads.one > 1",
				why: "A rule that reads one relation and negates a join is read as written: a probe of Ref's rows, and the whole rule's read of a document's references, negate Resolved as Node and Named joined at (pkg, path) under each reference's (pkg, path, start), which PostgreSQL with no statistics nests once for each reference, 22,441 rows for 134 written."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original:
					"\t\t\tconst query = navigatedQuery(source.query, loc, columns, sharing, interned)",
				replacement: "\t\t\tconst query = source.query",
				why: "A whole rule's read per unit is read as written, its step's rule never navigated: Placed's Named and Node joined within a document, which PostgreSQL with no statistics reads as a product it filters after, 4,539 rows for 134 written, and Resolved's negation as the first kill reads it."
			},
			{
				file: "test/support/substrate/substrate.ts",
				original: "\t\t\t\tOption.toArray(Option.map(moved, rebuilt)),",
				replacement: "\t\t\t\tOption.toArray(Option.none<PgStatement>()),",
				why: "A case's rolled-back rows, dead, stay in Node, Ref and Named, which hold the template's stored documents, as before: each extends the tables and their indexes for every later case on the worker, whose plans the planner prices at their density times every page, so a case's plan follows the cases before it (rule-binding's whole judge read 2,325 rows of a document of 64 nodes in ACCESS3's full run, its replay green); the reset cannot put the clone's standing back, and the property fails."
			},
			{
				file: "test/support/substrate/substrate.ts",
				original: "\t\t\t\tArr.make(bare(sizesRestored(standing)), bare(standingQuery))",
				replacement: "\t\t\t\tArr.make(bare(standingQuery))",
				why: "A case's ANALYZE writes Node's, Ref's and Named's sizes into pg_class in place, its own rows counted, and the ROLLBACK keeps them, as before: every later case on the worker plans those tables at the sizes an earlier case analyzed, and the reset's rebuild leaves them at their counted sizes where the template has none; the reset cannot put the clone's standing back, and the property fails."
			}
		]
	})
