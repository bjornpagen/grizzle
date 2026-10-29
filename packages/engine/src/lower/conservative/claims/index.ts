import { isNonEmpty } from "#compiler/core/nonempty.ts"
import { baseTypeRef } from "#compiler/lower/conservative/base-type.ts"
import {
	type Lowerers,
	type NodeLowerer,
	nodeLabel,
	refuse
} from "#compiler/lower/conservative/context.ts"
import type { ContextColumn, ContextSource } from "#compiler/sql/ast.ts"
import { col, columnDefinition, core, select, target } from "#compiler/sql/build.ts"

/**
 * Context: a context's one fact, read from the session's claims through its context source (sql/ast.ts ContextSource).
 *
 *   SELECT r1.c1, r1.c2 FROM <Session's source, holding exactly sid and sub> AS r1(c1 text COLLATE pg_c_utf8, c2 uuid)
 *
 * A context belongs to no schema and installs nothing: every reader reads the claims where it stands, a view of a role
 * and a runtime query alike. The source holds one row when the session's claims hold the context, none otherwise, so it
 * is at most one fact, a set without DISTINCT. A Context's heading is every field the context declares, at least one
 * (ir/desc.ts ContextDesc) and never pruned, so the source holds the member to exactly the keys the Db path writes for
 * it (adapter/db/claims.ts), and a member holding any other keys is refused where the context is read. The source reads
 * the member once, and each field is a column of it: its claim read by its base type, the type a relation parameter's
 * recordset reads (input-set/). The claims are encoded once per Db through each field's encoder, which checks the base
 * type, and PostgreSQL validated each refined claim at Db.open against its field's domain, a contract's or a pattern's
 * (adapter/admission/admit.ts), so no domain is applied again here. A text field is collated pg_catalog.pg_c_utf8, as
 * every stored text column is.
 */
const lowerContext: NodeLowerer<"Context"> = (node, cx) => {
	const origin = { kind: "node", node: node.id } as const
	const columns = node.heading.map((c): ContextColumn => ({
		field: c.name,
		column: columnDefinition(cx.supply.column(origin), baseTypeRef(cx.names, c.type))
	}))
	if (!isNonEmpty(columns)) {
		return refuse("MalformedDescription", nodeLabel(node), "a context of at least one field")
	}
	const source: ContextSource = {
		kind: "context",
		context: node.context,
		columns,
		refusal: cx.names.refusal,
		alias: cx.relationAlias(origin)
	}
	return select(
		core(
			columns.map((c) => target(col(source.alias, c.column.name))),
			[source],
			undefined
		)
	)
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const contextLowering: Lowerers<"Context"> = { Context: lowerContext }
