import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import type { InferredBindings, InferredExpr } from "#compiler/ir/desc.ts"

/** The leaves an arm's expressions are rewritten by: a variable or a field, each to its replacement. */
export interface LeafRewrite {
	readonly var: (id: string) => InferredExpr | undefined
	readonly field: (field: string) => InferredExpr | undefined
}

/** `e` with every variable and field leaf `leaves` replaces, replaced; an imported query is closed and kept whole. */
export const mapLeaves = (e: InferredExpr, leaves: LeafRewrite): InferredExpr => {
	const m = (x: InferredExpr): InferredExpr => mapLeaves(x, leaves)
	switch (e.kind) {
		case "var":
			return leaves.var(e.var) ?? e
		case "field":
			return leaves.field(e.field) ?? e
		case "value":
		case "parent":
		case "param":
		case "literal":
			return e
		case "compute":
			return { ...e, args: e.args.map(m) }
		case "cast":
		case "base":
			return { ...e, arg: m(e.arg) }
		case "cond":
			return { ...e, pred: m(e.pred), onTrue: m(e.onTrue), onFalse: m(e.onFalse) }
		case "when":
			return { ...e, subject: m(e.subject), proved: m(e.proved), otherwise: m(e.otherwise) }
		case "compare":
			return { ...e, left: m(e.left), right: m(e.right) }
		case "between":
			return { ...e, arg: m(e.arg), low: m(e.low), high: m(e.high) }
		case "in":
			return { ...e, arg: m(e.arg) }
		case "and":
		case "or":
			return { ...e, args: mapNonEmpty(e.args, m) }
		case "not":
			return { ...e, arg: m(e.arg) }
		case "allen":
			return { ...e, left: m(e.left), right: m(e.right) }
		case "pointIn":
			return { ...e, point: m(e.point), span: m(e.span) }
		case "absent":
			return { ...e, bindings: mapBindings(e.bindings, leaves) }
		case "closedAt":
			return { ...e, args: mapNonEmpty(e.args, m) }
		case "closedRow":
			return { ...e, args: e.args.map(m) }
		case "closedHas":
			return { ...e, args: mapNonEmpty(e.args, m) }
	}
}

export const mapBindings = (b: InferredBindings, leaves: LeafRewrite): InferredBindings =>
	Object.fromEntries(Object.entries(b).map(([f, e]) => [f, mapLeaves(e, leaves)] as const))

/** The variables `e` reads, an imported query's own aside. */
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
