import {
	distinctSelect,
	type Lowerers,
	type NodeLowerer
} from "#compiler/lower/conservative/context.ts"
import { col, lit, table, target } from "#compiler/sql/build.ts"

/**
 * Base: a scan of a stored relation, or of a derived relation's materialized view.
 *
 *   SELECT DISTINCT r1.<column>, ... FROM <schema>.<table> AS r1
 *
 * Every column is read by its physical name and never cast. The conservative
 * lowering trusts no key, the declared primary key included, so even the full scan is deduplicated: a
 * key that is not valid in the reading context, such as a deferred unique key inside its transaction, can never make
 * the baseline repeat a fact.
 */
const lowerBase: NodeLowerer<"Base"> = (node, cx) => {
	const name = cx.names.relation(node.relation)
	const alias = cx.relationAlias({
		kind: "occurrence",
		occurrence: node.occurrence,
		relation: node.relation
	})
	const targets =
		node.heading.length === 0
			? [target(lit.bool(true))]
			: node.heading.map((c) => target(col(alias, cx.names.column(node.relation, c.name))))
	return distinctSelect(targets, [table(name.schema, name.name, alias)], [])
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const baseLowering: Lowerers<"Base"> = { Base: lowerBase }
