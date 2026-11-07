import { isNonEmpty } from "#compiler/core/nonempty.ts"
import { baseTypeRef, qualifiedType } from "#compiler/ir/physical.ts"
import { baseOf, contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import {
	type LowerContext,
	type Lowerers,
	type NodeLowerer,
	nodeLabel,
	refuse
} from "#compiler/lower/conservative/context.ts"
import type { ContextColumn, ContextSource, TypeRef } from "#compiler/sql/ast.ts"
import { col, columnDefinition, provedCore, select, target } from "#compiler/sql/build.ts"

/**
 * The type a context field's claim is judged by (sql/ast.ts ContextColumn `judged`): its field's own, a contract's or a
 * pattern's domain (the lowering's physical type), or, for a closed id, its roster's domain, which admits a live
 * handle's code alone; else its base.
 */
const judgedType = (cx: LowerContext, t: ScalarType, at: string): TypeRef => {
	const base = baseOf(t)
	return contractOf(t) === undefined && base.carrier === "code"
		? qualifiedType(cx.names.rosterDomain(base.roster.closed))
		: cx.typeRef(t, at)
}

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
 * the member once, judging each claim by its field's own type (judgedType): a contract's, a pattern's or a roster's
 * domain, else its base, so a claim its refinement refuses raises 23514 wherever the context is read, whoever set the
 * claims, a Db or a direct writer by hand; and each field is a column of it, delivered by its base type, the type a
 * relation parameter's arrays read (input-set/). A text field is collated pg_catalog.pg_c_utf8, as every stored text
 * column is.
 */
const lowerContext: NodeLowerer<"Context"> = (node, cx) => {
	const origin = { kind: "node", node: node.id } as const
	const columns = node.heading.map((c): ContextColumn => ({
		field: c.name,
		column: columnDefinition(cx.supply.column(origin), baseTypeRef(cx.names, c.type)),
		judged: judgedType(cx, c.type, nodeLabel(node))
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
		provedCore(
			"oneRow",
			columns.map((c) => target(col(source.alias, c.column.name))),
			[source],
			undefined
		)
	)
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const contextLowering: Lowerers<"Context"> = { Context: lowerContext }
