/**
 * The judge's statements read of each relation only the columns their rule reads (lower/optimize/prune
 * sourcePrunePass): a scan of a stored relation delivers the columns the statement reads of it and its primary key, and
 * a session's delta the columns the statement reads, never a relation's whole heading. Each case is a rule over D, T's
 * facts by document and place, selected by a literal of T's `a` or not: S's containment in it, a check over its `b` or
 * a key over its `b` by document; whole, T and S immutable, or probed, both mutable. T and S each declare a field no
 * rule reads.
 *
 * Oracle: a specification, read off the shape: every scan of T, S or a delta of either in a judged statement, a stored
 * read as the binding states it (sql/ast.ts FromSource `read`, `probe`) among them, reads only fields the shape's rule
 * binds of that relation, its witness's among them, and delivers each to some reference of the statement, reads it in a
 * condition of its own (a conjunct the binding pushed into it, or a value of an outer row it delivers in the place of the
 * column its seek binds to it), or keeps it as a stored scan's key; every reader of a delta returns only such fields
 * (physical/ddl/deltas.ts headed, whose projection a statement's reads of a delta take whatever the lowering's pruning
 * left them); and every read an existence test makes reads no column of its table, and is advised an index-only scan in
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
import { judged, type Reached, shapeGen } from "#test/unit/physical/judge-sources.fixtures.ts"

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
				file: "packages/engine/src/physical/ddl/deltas.ts",
				original: "reads.read(selection.of, selection.conditions, [...places])",
				replacement:
					"reads.read(selection.of, selection.conditions, selection.of.delta.columns.map((_, at) => at))",
				why: "Every reader of a session's delta returns its relation's whole heading, so a probe reads T's pay or S's note from it, which no rule reads; the property fails."
			},
			{
				file: "packages/engine/src/analysis/demand/demand.ts",
				original: '\t\tcase "Step":\n\t\t\treturn demanded\n',
				replacement: '\t\tcase "Step":\n\t\t\treturn all(input)\n',
				why: "A navigation's step demands its input's whole heading whatever its readers read of it, so the existence test over a probed rule's region keeps the region's dead bindings: the scan of T under NOT EXISTS delivers `a` and `at`, which no reference reads, and its advice is an INDEX_SCAN that fetches every row where the index holds every column the read needs; the property fails."
			}
		]
	})
