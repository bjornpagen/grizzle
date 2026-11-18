import {
	type InferredBindings,
	type InferredExpr,
	mapBindingTerms,
	mapExprChildren
} from "#compiler/ir/desc.ts"

/** The leaves an arm's expressions are rewritten by: a variable or a field, each to its replacement. */
export interface LeafRewrite {
	readonly var: (id: string) => InferredExpr | undefined
	readonly field: (field: string) => InferredExpr | undefined
}

/**
 * `e` with every variable and field leaf `leaves` replaces, replaced, in its own scope (ir/desc.ts exprChildren): the
 * bind map of a query it negates among it, the query itself closed and kept whole.
 */
export const mapLeaves = (e: InferredExpr, leaves: LeafRewrite): InferredExpr =>
	e.kind === "var"
		? (leaves.var(e.var) ?? e)
		: e.kind === "field"
			? (leaves.field(e.field) ?? e)
			: mapExprChildren(e, (x) => mapLeaves(x, leaves))

export const mapBindings = (b: InferredBindings, leaves: LeafRewrite): InferredBindings =>
	mapBindingTerms(b, (e) => mapLeaves(e, leaves))

/** The variables `e` reads in its own scope (mapLeaves), an imported query's own aside. */
export const varsOf = (e: InferredExpr, into: Set<string>): Set<string> => {
	mapLeaves(e, {
		var: (id) => {
			into.add(id)
			return undefined
		},
		field: () => undefined
	})
	return into
}

/** `e` with each parameter `bound` names replaced by the term it binds, every other leaf as it is. */
export const boundIn = (e: InferredExpr, bound: ReadonlyMap<string, InferredExpr>): InferredExpr =>
	e.kind === "param" ? (bound.get(e.name) ?? e) : mapExprChildren(e, (x) => boundIn(x, bound))
