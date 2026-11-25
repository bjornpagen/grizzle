import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import {
	type FieldDesc,
	type InferredBindings,
	type InferredExpr,
	type InferredHead,
	type InferredQuery,
	type InferredRule,
	type InferredStage,
	mapBindingTerms,
	mapExprChildren
} from "#compiler/ir/desc.ts"

/** A reference to the variable `id`. */
export const varRef = (id: string): InferredExpr => ({ kind: "var", var: id })

/** A literal of no type of its own, which takes the type of the term it meets. */
export type BareLiteral = Extract<InferredExpr, { readonly kind: "literal" }> & {
	readonly type?: undefined
}

/** Whether `e` is a bare literal, which takes the type of the term it meets and so never stands first. */
export const isBare = (e: InferredExpr): e is BareLiteral =>
	e.kind === "literal" && e.type === undefined

/** The descriptor each column of a query is delivered at, as the checker types it (analysis/theory/columns.ts). */
export type ColumnTypes = (column: string) => FieldDesc

/** A bare literal under `type`, the type of the column it stands for. */
export const typedAs = (e: BareLiteral, type: FieldDesc): InferredExpr => ({ ...e, type })

/**
 * `e` as a term of the column `column` of a query whose columns are `columns`: a bare literal, a head's term or a
 * binding's, typed at the column it stands for, so wherever a substitution puts it, it is a term of that column's type,
 * which stands first as any term does; any other term itself. A literal compared with a term of another type is then
 * refused for the two types, never for its place.
 */
export const atColumn = (e: InferredExpr, column: string, columns: ColumnTypes): InferredExpr =>
	isBare(e) ? typedAs(e, columns(column)) : e

/**
 * A rule whose head delivers columns of `columns`, each bare literal of its head typed at the column it stands for
 * (`atColumn`).
 */
const typedRuleHead = (r: InferredRule, columns: ColumnTypes): InferredRule => ({
	...r,
	head: Object.fromEntries(
		Object.entries(r.head).map(([field, h]): readonly [string, InferredHead] => [
			field,
			h.kind === "literal" ? atColumn(h, field, columns) : h
		])
	)
})

/**
 * `query`, the checked definition of a relation whose columns the checker types at `columns`, with each bare literal of
 * a head that delivers its rows typed at the column it stands for: the type its position in its union proved it at
 * (check/checker.ts #positionedTypes), which a rule read apart from that union keeps (analysis/theory/unit.ts
 * unitStep), where alone it would take its JavaScript default, a bigint where the union delivered a natural. Every rule
 * of its rules and union stages, through a name, an attachment, an order, a take or an approximation, whose input's
 * heads deliver columns of the query; a recursion's rows are its declared row's, at which its seeds' bare literals are
 * typed where it is read per unit (unit.ts typedSeed), and it is never read apart.
 */
export const typedHeads = (query: InferredQuery, columns: ColumnTypes): InferredQuery => {
	const stage = (st: InferredStage): InferredStage => {
		switch (st.kind) {
			case "rules":
				return { ...st, arms: mapNonEmpty(st.arms, (r) => typedRuleHead(r, columns)) }
			case "union":
				return {
					...st,
					input: stage(st.input),
					arms: mapNonEmpty(st.arms, (r) => typedRuleHead(r, columns))
				}
			case "named":
			case "attach":
			case "order":
			case "take":
			case "approx":
				return { ...st, input: stage(st.input) }
			case "recursive":
				return st
		}
	}
	return { ...query, stage: stage(query.stage) }
}

/**
 * `left` = `right` in the order the checker reads it: as written, but a bare literal second. A binding of a definition
 * may be a JavaScript literal, so every equality a rule's queries or its navigation hold a binding by is built here.
 */
export const equal = (left: InferredExpr, right: InferredExpr): InferredExpr =>
	isBare(left)
		? { kind: "compare", op: "eq", left: right, right: left }
		: { kind: "compare", op: "eq", left, right }

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
