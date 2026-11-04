import type { ResolvedExpr } from "#compiler/check/params.ts"
import { compareStrings, mapInput } from "#compiler/core/order.ts"
import type {
	BindingsDesc,
	ExprDesc,
	HeadTermDesc,
	Located,
	ParamsAs,
	QueryDesc,
	QueryStageDesc,
	RuleDesc,
	SourceDesc
} from "#compiler/ir/desc.ts"

/** The entries of a Description record in canonical order: a record is unordered at the boundary. */
export const entries = <V>(
	record: Readonly<Record<string, V>>
): ReadonlyArray<readonly [string, V]> =>
	Object.entries(record).toSorted(
		mapInput(compareStrings, ([key]: readonly [string, unknown]) => key)
	)

/** A parameter reference an expression reads: a scalar one with its type, or a bind map's relation parameter. */
export type LeafParam<P extends object, T> =
	| ({ readonly kind: "param"; readonly type: T } & P)
	| ({ readonly kind: "relationParam" } & P)

/** What an expression reads in its own scope: its rule variables, its parent variables, and every parameter reference. */
export interface Leaves<P extends object, T> {
	readonly vars: Set<string>
	readonly parents: Set<string>
	readonly params: Array<LeafParam<P, T>>
}

const emptyLeaves = <P extends object, T>(): Leaves<P, T> => ({
	vars: new Set(),
	parents: new Set(),
	params: []
})

/**
 * The leaves an expression reads in its own scope: rule variables, parent variables and parameters. A relational
 * negation's bindings are read in the rule's scope too, and so is the bind map of the query it negates; the query
 * itself is its own scope.
 */
const exprLeaves = <P extends object, T>(
	e: ExprDesc<Located, ParamsAs<P, T>>,
	into: Leaves<P, T>
): void => {
	switch (e.kind) {
		case "var":
			into.vars.add(e.var)
			return
		case "parent":
			into.parents.add(e.column)
			return
		case "param":
			into.params.push(e)
			return
		case "field":
		case "value":
		case "literal":
			return
		case "compute":
			for (const a of e.args) {
				exprLeaves(a, into)
			}
			return
		case "cast":
		case "base":
		case "not":
		case "in":
			exprLeaves(e.arg, into)
			return
		case "cond":
			exprLeaves(e.pred, into)
			exprLeaves(e.onTrue, into)
			exprLeaves(e.onFalse, into)
			return
		case "when":
			exprLeaves(e.subject, into)
			exprLeaves(e.proved, into)
			exprLeaves(e.otherwise, into)
			return
		case "compare":
			exprLeaves(e.left, into)
			exprLeaves(e.right, into)
			return
		case "between":
			exprLeaves(e.arg, into)
			exprLeaves(e.low, into)
			exprLeaves(e.high, into)
			return
		case "and":
		case "or":
			for (const a of e.args) {
				exprLeaves(a, into)
			}
			return
		case "allen":
			exprLeaves(e.left, into)
			exprLeaves(e.right, into)
			return
		case "pointIn":
			exprLeaves(e.point, into)
			exprLeaves(e.span, into)
			return
		case "absent":
			bindingLeaves(e.bindings, into)
			sourceLeaves(e.source, into)
			return
	}
}

const bindingLeaves = <P extends object, T>(
	bindings: BindingsDesc<Located, ParamsAs<P, T>>,
	into: Leaves<P, T>
): void => {
	for (const [, e] of entries(bindings)) {
		exprLeaves(e, into)
	}
}

/** A source's bind map is evaluated in the importing rule's scope. */
const sourceLeaves = <P extends object, T>(
	s: SourceDesc<Located, ParamsAs<P, T>>,
	into: Leaves<P, T>
): void => {
	if (s.kind === "query") {
		for (const [, b] of entries(s.bind)) {
			if (b.kind === "relationParam") {
				into.params.push(b)
			} else {
				exprLeaves(b, into)
			}
		}
	}
}

const headLeaves = <P extends object, T>(
	h: HeadTermDesc<Located, ParamsAs<P, T>>,
	into: Leaves<P, T>
): void => {
	if (h.kind === "aggregate") {
		if (h.fn !== "count") {
			exprLeaves(h.arg, into)
		}
		return
	}
	if (h.kind === "producer") {
		for (const a of h.args) {
			exprLeaves(a, into)
		}
		return
	}
	exprLeaves(h, into)
}

/**
 * Structural walks over query descriptions, run before a rule or an attachment is checked.
 *
 * A rule's region must know every value it delivers before any node over it exists: the variables its matches bind,
 * and the outer values its filters and head read, which enter the region as correlated variables. An
 * attachment's correlation must be the same in every arm of its child, so the parent variables the child reads are
 * collected from all its arms first. These walks only collect; scope and types are checked when the
 * rules themselves are checked.
 *
 * Everything a rule reads in its own scope: its matches' bindings and bind maps, its filters and its head. Without
 * `direct`, a parameter that a match binding is exactly is left out: it fixes its column as a constant and needs no
 * value of its own in the region.
 */
export const ruleLeaves = <P extends object, T>(
	rule: RuleDesc<Located, ParamsAs<P, T>>,
	direct: boolean
): Leaves<P, T> => {
	const into = emptyLeaves<P, T>()
	for (const m of rule.matches) {
		for (const [, e] of entries(m.bindings).filter(
			([, binding]) => direct || binding.kind !== "param"
		)) {
			exprLeaves(e, into)
		}
		sourceLeaves(m.source, into)
	}
	for (const w of rule.where) {
		exprLeaves(w, into)
	}
	for (const [, h] of entries(rule.head)) {
		headLeaves(h, into)
	}
	return into
}

/**
 * What an attachment child reads from its parent, over every rule of its own stage chain: the parent columns, the
 * first source column each is bound to (in rule, match and canonical binding order), the head key that delivers one
 * unchanged, every head key and every attachment the child's own rows carry, so the correlation columns can be named
 * without colliding with the child's heading or its attachments.
 */
export interface ParentUse {
	readonly columns: Set<string>
	readonly firstBound: Map<string, string>
	readonly headAlias: Map<string, string>
	readonly headKeys: Set<string>
	readonly attachments: Set<string>
}

/** Whether a correlation column named `name` collides with a name the child's rows carry. */
const rowName = (use: ParentUse, name: string): boolean =>
	use.headKeys.has(name) || use.attachments.has(name)

/** `stem`, or `stem_n` for the least n from 2 that names no row of the child and that `taken` does not hold. */
export const freshColumnName = (
	use: ParentUse,
	stem: string,
	taken: ReadonlySet<string>
): string => {
	let name = stem
	for (let n = 2; rowName(use, name) || taken.has(name); n++) {
		name = `${stem}_${n}`
	}
	return name
}

export const parentUse = <P extends object, T>(
	child: QueryDesc<Located, ParamsAs<P, T>>
): ParentUse => {
	const use: ParentUse = {
		columns: new Set(),
		firstBound: new Map(),
		headAlias: new Map(),
		headKeys: new Set(),
		attachments: new Set()
	}
	const rule = (r: RuleDesc<Located, ParamsAs<P, T>>): void => {
		for (const a of r.attach) {
			use.attachments.add(a.name)
		}
		const leaves = ruleLeaves(r, true)
		for (const p of leaves.parents) {
			use.columns.add(p)
		}
		for (const [column, e] of r.matches.flatMap((m) => entries(m.bindings))) {
			if (e.kind === "parent" && !use.firstBound.has(e.column)) {
				use.firstBound.set(e.column, column)
			}
		}
		for (const [key, h] of entries(r.head)) {
			use.headKeys.add(key)
			if (h.kind === "parent" && !use.headAlias.has(h.column)) {
				use.headAlias.set(h.column, key)
			}
		}
	}
	/**
	 * A nested attachment's child reads its own parent, this child's rows, not ours; its name is on this child's
	 * rows.
	 */
	const stage = (s: QueryStageDesc<Located, ParamsAs<P, T>>): void => {
		switch (s.kind) {
			case "rules":
				for (const r of s.arms) {
					rule(r)
				}
				return
			case "union":
				stage(s.input)
				for (const r of s.arms) {
					rule(r)
				}
				return
			case "recursive":
				for (const r of s.recursive.base) {
					rule(r)
				}
				for (const r of s.recursive.rec) {
					rule(r)
				}
				return
			case "attach":
				use.attachments.add(s.attach.name)
				stage(s.input)
				return
			case "named":
			case "order":
			case "take":
			case "approx":
				stage(s.input)
				return
		}
	}
	stage(child.stage)
	return use
}

/**
 * Splits a rule's filters into its scalar predicates and its relational negations: a negation is a rule-level filter,
 * found at the top of a filter or inside a top-level conjunction.
 */
export const splitWhere = (
	where: ReadonlyArray<ResolvedExpr>
): {
	readonly scalar: ReadonlyArray<readonly [number, ResolvedExpr]>
	readonly negations: ReadonlyArray<
		readonly [number, Extract<ResolvedExpr, { readonly kind: "absent" }>]
	>
} => {
	const scalar: Array<readonly [number, ResolvedExpr]> = []
	const negations: Array<readonly [number, Extract<ResolvedExpr, { readonly kind: "absent" }>]> = []
	const visit = (i: number, e: ResolvedExpr): void => {
		if (e.kind === "absent") {
			negations.push([i, e])
		} else if (e.kind === "and" && e.args.some((a) => a.kind === "absent" || a.kind === "and")) {
			for (const a of e.args) {
				visit(i, a)
			}
		} else {
			scalar.push([i, e])
		}
	}
	for (const [i, e] of where.entries()) {
		visit(i, e)
	}
	return { scalar, negations }
}
