import {
	distinctSelect,
	headingTargets,
	type NodeLowerer
} from "#compiler/lower/conservative/context.ts"
import { inputSetSource } from "#compiler/lower/conservative/input-set/index.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"
import { core, select } from "#compiler/sql/build.ts"

/**
 * Relation parameters: one placeholder per array of the input, whatever its size.
 *
 * A relation-valued parameter is a set: repeated rows are one fact and an empty input is the empty relation, which
 * matches nothing. The host codec owns the set property and the null ban: it validates every field, refuses null
 * members, deduplicates complete facts by their identity and encodes canonically (codec/recordset.ts). So the
 * statement reads the input as a set without a DISTINCT, which the physical analysis records as the
 * `deduplicatedInput` key of an InputSet.
 *
 * Transport: every execution sends the input as its arrays (sql/ast.ts ArraysSource), one text-format array literal per
 * column, or, for an input of no column, its count of facts. One form serves every size, the empty input included,
 * which is arrays of no element; each array is a constant of the execution's custom plan, so the planner estimates
 * the input's rows as its length exactly (sql/print.ts). An execution's placeholders travel in one Bind message, which
 * PostgreSQL reads up to its message limit (core/limits.ts messageMaxBytes); a statement whose Bind message would be
 * longer is refused on the host before its flight is sent, as InputTooLarge (the shell's wire/batch.ts).
 *
 * InputSet as its arrays read without a DISTINCT:
 *
 *   SELECT r1.c1, r1.c2 FROM (SELECT pg_catalog.unnest($1::uuid[]) AS c1,
 *     pg_catalog.unnest($2::bigint[]) AS c2) AS r1
 *
 * Each array's element type is its column's base type (a closed id's smallint code, a text column's array names the fixed
 * collation), and the columns are generated names, recorded in the statement's slots. A membership's row is the
 * one-row VALUES of the values its caller names, in those types (conservative/input-set inputSetSource). The node's
 * own boundary stays a DISTINCT only where a placement realized one, which a deduplicated input or a row never needs.
 */
export const inputSetLowerer =
	(facts: ShapeFacts): NodeLowerer<"InputSet"> =>
	(node, cx) => {
		const { item, map } = inputSetSource(node, cx)
		const targets = headingTargets(node.heading, map)
		if (facts.realization(node) === "distinct" && !facts.unique(node)) {
			return distinctSelect(targets, [item], [])
		}
		return select(core(targets, [item], undefined))
	}
