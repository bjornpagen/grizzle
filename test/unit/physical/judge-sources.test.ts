/**
 * The judge's statements read of each relation only the columns their rule reads (lower/optimize/prune
 * sourcePrunePass): a scan of a stored relation delivers the columns the statement reads of it and its primary key, and
 * a session's delta the columns the statement reads, never a relation's whole heading. Each case is a rule over D, T's
 * facts by document and place, selected by a literal of T's `a` or not: S's containment in it, a check over its `b` or
 * a key over its `b` by document; whole, T and S immutable, or probed, both mutable. T and S each declare a field no
 * rule reads.
 *
 * Oracle: a specification, read off the shape: every scan of T, S or a delta of either in a judged statement reads only
 * fields the shape's rule binds of that relation, its witness's among them, and delivers each to some reference of the
 * statement, but a stored scan's key; and every reader of a delta returns only such fields (physical/ddl/deltas.ts
 * headed, whose projection a statement's reads of a delta take whatever the lowering's pruning left them).
 *
 * Features: a whole rule's statement and a probe's; a stored scan and a delta narrowed below their relation's width.
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
			"a delta narrowed"
		] satisfies ReadonlyArray<ReachedOf<Reached>>,
		check: (_, c: Case<Reached>) => (shape) => Effect.sync(() => judged(shape, c.note)),
		oracle: {
			kind: "specification",
			name: "the shape's rule: each scan reads only fields the rule binds of its relation, each delivered to a reference of the statement, but a stored scan's key"
		},
		box: "every rule over D of T, a containment of S, a check or a key, its arm selecting T by a literal or not, whole or probed",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/prune/index.ts",
				original:
					'\t\t\t\treturn reach === "withSources" ? narrowedBase(node, demanded) : undefined',
				replacement: "\t\t\t\treturn undefined",
				why: "A stored scan keeps its relation's whole heading, so a judged statement reads T's pay, which no rule reads; the property fails."
			},
			{
				file: "packages/engine/src/physical/ddl/deltas.ts",
				original: "reads.read(selection.of, selection.conditions, [...places])",
				replacement:
					"reads.read(selection.of, selection.conditions, selection.of.delta.columns.map((_, at) => at))",
				why: "Every reader of a session's delta returns its relation's whole heading, so a probe reads T's pay or S's note from it, which no rule reads; the property fails."
			}
		]
	})
