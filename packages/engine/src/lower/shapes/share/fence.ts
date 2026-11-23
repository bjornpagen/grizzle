import type { NodeOf } from "#compiler/ir/rel.ts"
import { type Env, type LowerContext, refuse } from "#compiler/lower/conservative/context.ts"
import type { OperandSelect } from "#compiler/sql/ast.ts"

/**
 * A searched occurrence's scan as its region reads it, the core a fence over it extends (lower/shapes/vector fenceOf,
 * lower/shapes/search searchFenced): one plain core over its one table, with no order and no bound of its own, and the
 * alias it reads the table under. A scan the lowering spells otherwise is refused with `capability`.
 */
export const fencedScan = (
	cx: LowerContext,
	base: NodeOf<"Base">,
	env: Env,
	at: string,
	capability: string
): {
	readonly scan: OperandSelect
	readonly body: Extract<OperandSelect["body"], { readonly kind: "core" }>
	readonly alias: string
} => {
	const scan = cx.lower(base, env)
	const body = scan.body
	const [table, ...more] = body.kind === "core" ? body.from : []
	if (
		body.kind !== "core" ||
		body.distinct !== false ||
		scan.orderBy.length > 0 ||
		scan.limit !== undefined ||
		scan.offset !== undefined ||
		table?.kind !== "table" ||
		more.length > 0
	) {
		return refuse("UnsupportedOperation", at, capability)
	}
	return { scan, body, alias: table.alias }
}
