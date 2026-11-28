/**
 * The judge's statements read of each relation only the columns their rule reads (lower/optimize/prune
 * sourcePrunePass): a scan of a stored relation delivers the columns the statement reads of it and its primary key, and
 * a scan of a delta's array the columns the statement reads, never a relation's whole heading. Each case is a rule over D, T's
 * facts by document and place, selected by a literal of T's `a` or not: S's containment in it, a check over its `b` or
 * a key over its `b` by document; whole, T and S immutable, or probed, both mutable. T and S each declare a field no
 * rule reads.
 *
 * Oracle: a specification, read off the shape: every scan of T, S or a delta of either in a judged statement, a stored
 * read as the binding states it (sql/ast.ts FromSource `read`, `probe`) among them, reads only fields the shape's rule
 * binds of that relation, its witness's among them, and delivers each to some reference of the statement, reads it in a
 * condition of its own (a conjunct the binding pushed into it, or a value of an outer row it delivers in the place of the
 * column its seek binds to it), or keeps it as a stored scan's key, a delta's array read as `unnest(<argument>)` its
 * columns by place (physical/ddl/deltas.ts headed); and every read an existence test makes reads no column of its
 * table, and is advised an index-only scan in
 * the routine that runs it (sql/advice.ts), since its seek's index holds every column it needs. A navigation's step
 * passes its readers' demand to its input (analysis/demand/demand.ts), so an existence test over a probed rule's region
 * reads none of the region's dead bindings, `a` and `at`, which turned the read into an index scan.
 *
 * Features: a whole rule's statement and a probe's; a stored scan and a delta narrowed below their relation's width; an
 * existence read advised index-only.
 */

import { type Reached as ReachedOf } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type GuardReached,
	guarded,
	guardedGen,
	judged,
	type Reached,
	shapeGen
} from "#test/unit/physical/judge-sources.fixtures.ts"

/** Each judged statement reads of a relation exactly the columns its rule reads, and a stored relation's key. */
export const eachJudgedStatementReadsOfARelationExactlyTheColumnsItsRuleReadsAndAStoredRelationsKey =
	property.exhaust(finite(shapeGen), {
		needs: {},
		situations: [
			"a whole rule's statement",
			"a probe's statement",
			"a stored scan narrowed",
			"a delta narrowed",
			"an existence read index-only"
		] satisfies ReadonlyArray<ReachedOf<Reached>>,
		check: (_, c: Case<Reached>) => (shape) => Effect.sync(() => judged(shape, c.note)),
		oracle: {
			kind: "specification",
			name: "the shape's rule: each scan reads only fields the rule binds of its relation, each delivered to a reference of the statement or read by a condition of its own, but a stored scan's key; an existence read advised index-only"
		},
		box: "every rule over D of T, a containment of S, a check or a key, its arm selecting T by a literal or not, whole or probed",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/demand/demand.ts",
				original: '\t\tcase "Step":\n\t\t\treturn demanded\n',
				replacement: '\t\tcase "Step":\n\t\t\treturn all(input)\n',
				why: "A navigation's step demands its input's whole heading whatever its readers read of it, so the existence test over a probed rule's region keeps the region's dead bindings: the scan of T under NOT EXISTS delivers `a` and `at`, which no reference reads, and its advice is an INDEX_SCAN that fetches every row where the index holds every column the read needs; the property fails."
			}
		]
	})

/**
 * A guard's existence read reads of its table only what its conditions read, and is advised an index-only scan: the
 * judge's guard of a probe (analysis/theory/query.ts probeGuard), its top-level IF EXISTS, reads Value at the written
 * package, and its derived table delivers to nothing above it. The table delivers Value's key, as every scan of a stored
 * relation does, which PostgreSQL leaves unread where no reference reads it (allpaths.c remove_unused_subquery_outputs);
 * counting its targets' columns as read, or the columns another statement's item of its alias reads, as the needs of its
 * routine read off the routine whole did, made its advice an INDEX_SCAN, one heap fetch a row where the index holds
 * every column it reads (rule-guard's guard over Bound's delta and its twin over Node's, 201 rows read where one bounds
 * it, main's measure from CARRIERS).
 */
export const aGuardsExistenceReadReadsWhatItsConditionsReadAndIsAdvisedAnIndexOnlyScan =
	property.exhaust(finite(guardedGen), {
		needs: {},
		situations: [
			"a guard over a write of Bound",
			"a guard over a write of Node"
		] satisfies ReadonlyArray<ReachedOf<GuardReached>>,
		check: (_, c: Case<GuardReached>) => (g) => Effect.sync(() => guarded(g, c.note)),
		oracle: {
			kind: "specification",
			name: "a guard's existence read reads its conditions' columns alone and is advised INDEX_ONLY_SCAN"
		},
		box: "Value keyed by its learner, then its package and place in either order, beside each bounded node of its package, its score at most or at least the bound",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/bind.ts",
				original: "\t\t\t\tif (column === undefined || opaque(t.expr) || returnsSet(t.expr)) {\n",
				replacement: "\t\t\t\tif (column !== undefined) {\n",
				why: "Every named target of a derived table counts its columns as read whether or not a reference reads them, so the guard's existence read of Value reads the learner and the place its table delivers, which no reference reads, and its advice is an INDEX_SCAN; the property fails."
			},
			{
				file: "packages/engine/src/sql/bind.ts",
				original:
					"\troutineOf(fn: CreateFunction): CreateFunction {\n\t\tthis.#whole = false\n\t\treturn this.routine(fn)\n\t}\n\n\t/** A DO block's body bound (bindBlock), each query it hands the planner over its own columns' needs (`planned`); a\n\t * whole one's reads joined by hash. */\n\tblockOf(b: PlBlock): PlBlock {\n\t\tthis.#whole = this.#reads.kind === \"whole\"\n\t\treturn this.block(b)\n\t}\n\n\t/**\n\t * `bind` run over the needs of one query PL/pgSQL hands the planner on its own, which `collect` walks: each alias's\n\t * columns that query reads, never another's. A routine's statements are lowered apart, each naming its items from a\n\t * supply of its own, so one alias names items of two of them, and a routine's needs read off it whole counted the\n\t * columns of both among a read's: the cover an index-only scan's choice reads (sql/advice.ts), so rule-guard's guard,\n\t * which reads of Value its package alone, was advised an INDEX_SCAN for the columns of an item of its probe's\n\t * statement under the same alias.\n\t */\n\t#planned<A>(collect: (t: Transform) => unknown, bind: () => A): A {\n\t\tconst needs = this.#needs\n\t\tthis.#needs = neededBy(collect)\n",
				replacement:
					"\troutineOf(fn: CreateFunction): CreateFunction {\n\t\tthis.#needs = neededColumns(fn)\n\t\tthis.#whole = false\n\t\treturn this.routine(fn)\n\t}\n\n\t/** A DO block's body bound (bindBlock), each query it hands the planner over its own columns' needs (`planned`); a\n\t * whole one's reads joined by hash. */\n\tblockOf(b: PlBlock): PlBlock {\n\t\tthis.#needs = neededBy((t) => t.plBlock(b))\n\t\tthis.#whole = this.#reads.kind === \"whole\"\n\t\treturn this.block(b)\n\t}\n\n\t/**\n\t * `bind` run over the needs of one query PL/pgSQL hands the planner on its own, which `collect` walks: each alias's\n\t * columns that query reads, never another's. A routine's statements are lowered apart, each naming its items from a\n\t * supply of its own, so one alias names items of two of them, and a routine's needs read off it whole counted the\n\t * columns of both among a read's: the cover an index-only scan's choice reads (sql/advice.ts), so rule-guard's guard,\n\t * which reads of Value its package alone, was advised an INDEX_SCAN for the columns of an item of its probe's\n\t * statement under the same alias.\n\t */\n\t#planned<A>(collect: (t: Transform) => unknown, bind: () => A): A {\n\t\tconst needs = this.#needs\n\t\tthis.#needs = needs\n",
				why: "A routine's needs gather across the queries it hands the planner, so the guard's read of Value counts the columns another statement's item of its alias reads, and its advice is an INDEX_SCAN; the property fails."
			}
		]
	})
