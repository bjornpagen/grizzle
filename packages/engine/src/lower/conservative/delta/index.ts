import { isNonEmpty, mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { emptyRelation } from "#compiler/lower/conservative/closed/index.ts"
import {
	distinctSelect,
	type Lowerers,
	type NodeLowerer,
	nodeLabel,
	refuse
} from "#compiler/lower/conservative/context.ts"
import type { DeltaRelation } from "#compiler/lower/conservative/types.ts"
import type { FromSource } from "#compiler/sql/ast.ts"
import { col, cteRefAs, target, unitTargets } from "#compiler/sql/build.ts"

/**
 * Delta: a read-back's netted delta.added(R) or delta.removed(R).
 *
 *   SELECT DISTINCT r12.c4, r12.c5 FROM r9 AS r12
 *
 * A delta is the write program's: the write compiler hands the lowering the relation that holds it, each field of the
 * delta's heading with its column (DeltaRelation), and the node reads the column of each field it delivers, every field
 * of its relation's heading as the checker builds it or those pruning leaves it (lower/optimize/prune). A read-back
 * over a delta a statement makes rides that statement, and the delta is a CTE of it over the rows its RETURNING
 * returns; the conservative realization's, computed by comparing the states before and after the change, is a
 * carrier. A side of a delta no statement makes is the empty relation, as an empty closed relation lowers. A rule
 * probe over its region reads its relation's side: a CTE named by the session's delta, each read of which the judge
 * reads through the reader of its selection (physical/ddl/deltas.ts headed), or the relation's own table in its check
 * over every row (physical/ddl/rules.ts everyRow).
 * Anywhere else there is no delta, and the node is UnsupportedOperation.
 */
const lowerDelta: NodeLowerer<"Delta"> = (node, cx) => {
	const at = nodeLabel(node)
	const subject = cx.options.subject
	const source =
		subject.kind === "readBack" || subject.kind === "ruleRegion"
			? subject.deltas(node.relation, node.side)
			: undefined
	if (source === undefined) {
		return refuse(
			"UnsupportedOperation",
			at,
			`delta.${node.side}(${node.relation}) outside a write program that supplies its delta relation`
		)
	}
	if (source.kind === "empty") {
		return emptyRelation(cx, node.heading, node.id)
	}
	const alias = cx.relationAlias({ kind: "node", node: node.id })
	const columnOf = (field: string): string =>
		source.columns.find((c) => c.field === field)?.column ??
		refuse("MalformedDescription", at, `a delta relation that holds the field ${field}`)
	const targets = isNonEmpty(node.heading)
		? mapNonEmpty(node.heading, (c) => target(col(alias, columnOf(c.name))))
		: unitTargets
	const from: FromSource = deltaFrom(source, alias)
	return distinctSelect(targets, [from], [])
}

/** The FROM item of a delta relation that holds rows, under `alias`. */
const deltaFrom = (
	source: Exclude<DeltaRelation, { readonly kind: "empty" }>,
	alias: string
): FromSource => {
	switch (source.kind) {
		case "cte":
			return cteRefAs(source.cte, alias)
		case "carrier":
			return { kind: "table", table: source.carrier, alias }
		case "table":
			return { kind: "table", table: source.table, alias }
	}
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const deltaLowering: Lowerers<"Delta"> = { Delta: lowerDelta }
