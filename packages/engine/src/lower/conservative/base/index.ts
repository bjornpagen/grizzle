import { isNonEmpty, mapNonEmpty } from "#compiler/core/nonempty.ts"
import type { NodeOf } from "#compiler/ir/rel.ts"
import {
	distinctSelect,
	type LowerContext,
	type Lowerers,
	type NodeLowerer
} from "#compiler/lower/conservative/context.ts"
import { col, provedSelect, table, target, unitTargets } from "#compiler/sql/build.ts"

/**
 * Whether a Base reads its table as the keyed set it is: in a violation probe, a stored relation's table whose heading
 * holds its primary key. A stored relation's PRIMARY KEY is never deferrable (sql/print.ts printConstraint), so its
 * table holds no row twice at any statement, and a violation probe is a statement of its own over stored tables.
 */
const readsKeyedTable = (node: NodeOf<"Base">, cx: LowerContext): boolean =>
	cx.options.subject.kind === "violationProbe" &&
	node.relationKind === "relation" &&
	node.primaryKey.every((k) => node.heading.some((c) => c.name === k))

/**
 * Base: a scan of a stored relation, or of a derived relation's materialized view.
 *
 *   SELECT DISTINCT r1.<column>, ... FROM <schema>.<table> AS r1
 *
 * Every column is read by its physical name and never cast. The conservative
 * lowering trusts no key, the declared primary key included, so even the full scan is deduplicated: a
 * key that is not valid in the reading context, such as a deferred unique key inside its transaction, can never make
 * the baseline repeat a fact.
 *
 * A violation probe reads a stored relation's table plainly, under the proof `keyed` (readsKeyedTable):
 *
 *   SELECT r1.<column>, ... FROM <schema>.<table> AS r1
 *
 * which PostgreSQL flattens into the join that reads it, so the probe joins tables, by their indexes and under their
 * statistics, rather than one deduplicated subquery per table, which hides both.
 */
const lowerBase: NodeLowerer<"Base"> = (node, cx) => {
	const name = cx.names.relation(node.relation)
	const alias = cx.relationAlias({
		kind: "occurrence",
		occurrence: node.occurrence,
		relation: node.relation
	})
	const targets = isNonEmpty(node.heading)
		? mapNonEmpty(node.heading, (c) => target(col(alias, cx.names.column(node.relation, c.name))))
		: unitTargets
	const from = [table(name.schema, name.name, alias)]
	return readsKeyedTable(node, cx)
		? provedSelect("keyed", targets, from, undefined)
		: distinctSelect(targets, from, [])
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const baseLowering: Lowerers<"Base"> = { Base: lowerBase }
