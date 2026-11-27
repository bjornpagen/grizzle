/**
 * Print pulled up (sql/pull-up.ts): a statement's text states a sub-query of a FROM list only where PostgreSQL plans it
 * as one. A simple sub-query, one core of no WITH, ORDER BY, LIMIT, OFFSET, DISTINCT, GROUP BY or HAVING whose targets
 * call no aggregate, window or set-returning function and no VOLATILE one, which PostgreSQL pulls up into its reader
 * before it plans, is printed flattened into its reader: its FROM items in its place, its WHERE conjoined before the
 * reader's, and every reference to its columns, the reader's ORDER BY's among them, its target. Every other sub-query
 * stays one, and a statement holding a simple one is refused as an internal compiler error.
 *
 * Box: every reader of one or two FROM items, each a table, a simple sub-query (plain, filtered, of a computed target,
 * reading a simple sub-query in turn, or reading one only a second round flattens) or a sub-query kept for one reason
 * each (an aggregate, a set-returning or a VOLATILE target, an ORDER BY, DISTINCT, a GROUP BY, LATERAL, a placeholder
 * no reference reads, a correlated target an aggregate reads, the reader then LATERAL beside the outer relation it
 * reads), with and without a WHERE reading the first item's first column again, an ORDER BY of the first item's two
 * columns, reading its first again as the WHERE does, and a reference reading a column name unqualified, which the
 * printer refuses: a column named unqualified in a query reads a name nothing binds
 * there, held at the statement as the lowering built it (sql/scope.ts assertScoped, 962f3a9fd4), which superseded the
 * pin that kept a sub-query whose column such a reference named.
 *
 * Oracle: the statement built a second way, each simple sub-query flattened into its reader by hand, printed; the
 * invariant read off the shape; and the printer's scope refusal of every reader reading a column unqualified.
 *
 * Features: a sub-query flattened, a chain of them, one in a second round, a WHERE conjoined, a computed target
 * substituted, an ORDER BY read through, and each reason a sub-query stays one, a computed target read twice among them.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { printedOnce } from "#compiler/sql/print-once.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { assertPulledUp, pulledUpStatement } from "#compiler/sql/pull-up.ts"
import {
	flattenedByHand,
	holdsFlattenable,
	type PullUpFeature,
	pullUpFeatures,
	type ReaderShape,
	readerFeaturesOf,
	readerGen,
	readerStatementOf,
	refusesUnqualified
} from "#test/unit/sql/pull-up.fixtures.ts"

/** Exactly the sub-queries PostgreSQL pulls up are printed flattened, and a statement holding one is refused. */
export const everySimpleSubQueryOfAFromListIsPrintedFlattenedIntoItsReaderExactlyWherePostgreSQLPullsItUp =
	property.exhaust(finite(readerGen), {
		needs: {},
		situations: pullUpFeatures,
		check: (_, k: Case<PullUpFeature>) => (shape: ReaderShape) =>
			Effect.sync(() => {
				for (const feature of readerFeaturesOf(shape)) {
					k.note(feature)
				}
				const statement = readerStatementOf(shape)
				if (shape.unqualified) {
					assert.throws(
						() => printedOnce(statement),
						refusesUnqualified,
						`${Formatter.format(shape)}: a reader naming a column unqualified, refused for its scope`
					)
					return
				}
				assert.equal(
					printStatement(pulledUpStatement(statement)),
					printStatement(flattenedByHand(shape)),
					`${Formatter.format(shape)}: each simple sub-query flattened into its reader, every other kept`
				)
				let refused = false
				try {
					assertPulledUp(statement)
				} catch {
					refused = true
				}
				assert.equal(
					refused,
					holdsFlattenable(shape),
					`${Formatter.format(shape)}: refused exactly where it holds a sub-query PostgreSQL pulls up`
				)
				assertPulledUp(printedOnce(statement))
			}),
		oracle: {
			kind: "second-implementation",
			name: "the shape's statement built with each simple sub-query flattened into its reader by hand, the invariant read off the shape, and the scope refusal of an unqualified reference"
		},
		box: "a reader of one or two FROM items of every kind, with and without a WHERE, an ORDER BY and an unqualified reference",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/pull-up.ts",
				original:
					'\tif (item.lateral || pinned.aliases.has(item.alias) || !simpleQuery(q) || q.body.kind !== "core") {\n',
				replacement:
					'\tif (pinned.aliases.has(item.alias) || !simpleQuery(q) || q.body.kind !== "core") {\n',
				why: "A LATERAL sub-query flattened: its references to the items before it, which PostgreSQL pulls up only under conditions of its own, moved into a FROM list that no longer says LATERAL."
			},
			{
				file: "packages/engine/src/sql/pull-up.ts",
				original: "\t\tsimple &&= overRowsOf(x) === undefined && !returnsSet(x)\n",
				replacement: "\t\tsimple &&= !returnsSet(x)\n",
				why: "A sub-query of an aggregate target flattened: its one row of aggregates becomes the reader's aggregate over every row the reader joins."
			},
			{
				file: "packages/engine/src/sql/pull-up.ts",
				original: "\t\tsimple &&= overRowsOf(x) === undefined && !returnsSet(x)\n",
				replacement: "\t\tsimple &&= overRowsOf(x) === undefined\n",
				why: "A sub-query of a set-returning target flattened: its rows multiplied by the reader's other items, the set-returning call moved into the reader's targets."
			},
			{
				file: "packages/engine/src/sql/pull-up.ts",
				original: '\t\t\t\t\t"VOLATILE"\n',
				replacement: '\t\t\t\t\t"STABLE"\n',
				why: "A sub-query of a VOLATILE target flattened: the call evaluated once per reference to its column, never once per row of the sub-query."
			},
			{
				file: "packages/engine/src/sql/pull-up.ts",
				original: "\tq.orderBy.length === 0 &&\n",
				replacement: "",
				why: "A sub-query of its own ORDER BY flattened: the order it states, which PostgreSQL keeps by planning it as one, lost."
			},
			{
				file: "packages/engine/src/sql/pull-up.ts",
				original: "\tq.body.distinct === false &&\n",
				replacement: "",
				why: "A DISTINCT sub-query flattened: its duplicates kept in the reader."
			},
			{
				file: "packages/engine/src/sql/pull-up.ts",
				original: "\tq.body.groupBy.length === 0 &&\n",
				replacement: "",
				why: "A grouped sub-query flattened: one row per group becomes one row per row grouped."
			},
			{
				file: "packages/engine/src/sql/pull-up.ts",
				original: "\t\t\t\torderBy: query.orderBy.map((o) => ({ ...o, expr: through(o.expr) })),\n",
				replacement: "\t\t\t\torderBy: query.orderBy,\n",
				why: "A reader's ORDER BY left reading a flattened sub-query's column, whose alias is gone."
			},
			{
				file: "packages/engine/src/sql/pull-up.ts",
				original: "\t\t\twheres.push(conjunct)\n",
				replacement: "",
				why: "A flattened sub-query's WHERE dropped: the reader reads every row its table holds."
			},
			{
				file: "packages/engine/src/sql/pull-up.ts",
				original: "\treturn holdsPlaceholder(e) || holdsSubquery(e) ? n === 1 : n <= 1\n",
				replacement: "\treturn holdsSubquery(e) ? n === 1 : n <= 1\n",
				why: "A sub-query whose placeholder no reference reads flattened: the placeholder gone from its unit's text, the unit's block of placeholders broken and PostgreSQL left a parameter of no type."
			},
			{
				file: "packages/engine/src/sql/pull-up.ts",
				original: "\treturn holdsPlaceholder(e) || holdsSubquery(e) ? n === 1 : n <= 1\n",
				replacement: "\treturn holdsPlaceholder(e) || holdsSubquery(e) ? n === 1 : true\n",
				why: "A computed target read twice substituted at both references: the expression printed twice where its level printed it once."
			},
			{
				file: "packages/engine/src/sql/pull-up.ts",
				original: "\t\tflat !== undefined;\n\t\tflat = flattened(current, pinned)\n",
				replacement: "\t\tflat !== undefined;\n\t\tflat = undefined\n",
				why: "One round only: a sub-query a flattened one brought into its reader, read once there, left a level PostgreSQL pulls up, which the invariant refuses."
			},
			{
				file: "packages/engine/src/sql/pull-up.ts",
				original: "\t\t\t(aggregated?.has(column) === true && !anchored(t.expr, own))\n",
				replacement: "\t\t\tfalse\n",
				why: "A correlated target an aggregate of the reader reads flattened into its argument: the aggregate, reading outer columns alone, becomes the outer query's, which a FROM item of its own level cannot hold (42803, rule-aggregate's keyed LATERAL aggregate at train C's tip)."
			},
			{
				file: "packages/engine/src/sql/pull-up.ts",
				original:
					"\t\t\tcore: namesKept(substitution.coreChildren({ ...core, from, where }), core),\n",
				replacement: "\t\t\tcore: substitution.coreChildren({ ...core, from, where }),\n",
				why: "A kept sub-query's bare target rewritten by the flatten of the one it reads renamed: its column, named by the bare column, takes the substituted column's name, and its reader's reference names a column the query no longer delivers (42703, rule-aggregate's lateral key read at train C's tip)."
			},
			{
				file: "packages/engine/src/sql/pull-up.ts",
				original: "\tfor (const clause of clauses) {\n\t\tcounting.expr(clause)\n\t}\n",
				replacement: "",
				why: "A target its query's ORDER BY reads again counted by the core's references alone, read once, so substituted at both: a computed target printed twice where its level printed it once, and a placeholder twice in its unit's text (a placeholder target an ordered reader's core and its ORDER BY read, which test/pg/sql/fold found against a twin no pull-up reads through)."
			},
			{
				file: "packages/engine/src/sql/pull-up.ts",
				original: "\t\t\tclauses: clauses.map((clause) => substitution.expr(clause))\n",
				replacement: "\t\t\tclauses\n",
				why: "A query's clauses counted in a second round as they read before the first: their references to a sub-query the first round flattened in, which now read its FROM items, are not counted, so a computed target of a second round's sub-query the ORDER BY reads again is substituted at both."
			},
			{
				file: "packages/engine/src/sql/print-once.ts",
				original:
					"\tconst printed = pulledUpStatement(isDmlWithWith(nested) ? dmlPrintedOnce(nested) : nested)\n",
				replacement: "\tconst printed = isDmlWithWith(nested) ? dmlPrintedOnce(nested) : nested\n",
				why: "No sub-query printed flattened: every simple level left to PostgreSQL's pull-up, which the invariant refuses."
			}
		]
	})
