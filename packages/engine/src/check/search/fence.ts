import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { NodeOf } from "#compiler/ir/rel.ts"
import { conjuncts } from "#compiler/logical/props.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"

/**
 * The occurrence a filter's text search reads through its fence (lower/shapes/search searchFenced), and which no other
 * path of the read reaches (physical/access/extract.ts): a conjunct of the filter that matches a stored search document
 * (registry.ts websearchMatches, plainMatches) against a query that reads no row, the document a variable of the
 * filter's own region one occurrence alone binds, of a stored relation or a derived relation's view that occurrence alone
 * matches. The occurrence's relation, the field it binds the document from, the variable, and the conjunct.
 */
export interface SearchedOccurrence {
	readonly base: NodeOf<"Base">
	readonly field: string
	readonly variable: string
	readonly conjunct: ScalarExpr
}

/** The occurrence `filter`'s first text search over its region reads through its fence (`SearchedOccurrence`), or none. */
export const searchedOccurrence = (filter: NodeOf<"Filter">): SearchedOccurrence | undefined => {
	const region = filter.input
	if (region.kind !== "MatchRegion") {
		return undefined
	}
	for (const conjunct of conjuncts(filter.pred)) {
		if (conjunct.kind !== "op") {
			continue
		}
		const fn = nativeOp(conjunct.op)?.fn
		const [document, query] = conjunct.args
		if (
			(fn !== "websearchMatches" && fn !== "plainMatches") ||
			document?.kind !== "column" ||
			document.column.node !== region.id ||
			query === undefined ||
			query.deps.nodes.length > 0
		) {
			continue
		}
		const variable = document.column.name
		const bound = region.occurrences.flatMap((o) =>
			o.bindings
				.filter((b) => b.var.name === variable)
				.map((b) => ({ occurrence: o, column: b.column }))
		)
		const [only, ...more] = bound
		const base = only?.occurrence.source
		if (
			only === undefined ||
			more.length > 0 ||
			base?.kind !== "Base" ||
			base.relationKind === "world" ||
			region.occurrences.filter((o) => o.source === base).length > 1
		) {
			continue
		}
		return { base, field: only.column, variable, conjunct }
	}
	return undefined
}
