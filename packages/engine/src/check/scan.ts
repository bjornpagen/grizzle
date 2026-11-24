import type { ResolvedExpr } from "#compiler/check/params.ts"
import { compareStrings, mapInput } from "#compiler/core/order.ts"
import {
	type BindingsDesc,
	type BindMapDesc,
	type ExprDesc,
	exprChildren,
	type HeadTermDesc,
	headTerms,
	type Located,
	type ParamsAs,
	type QueryDesc,
	type QueryStageDesc,
	type RuleDesc,
	type SourceDesc
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
 * negation's or existence's bindings are read in the rule's scope too, and so is the bind map of the query it reads;
 * the query itself is its own scope.
 */
const exprLeaves = <P extends object, T>(
	e: ExprDesc<Located, ParamsAs<P, T>>,
	into: Leaves<P, T>
): void => {
	if (e.kind === "var") {
		into.vars.add(e.var)
	} else if (e.kind === "parent") {
		into.parents.add(e.column)
	} else if (e.kind === "param") {
		into.params.push(e)
	} else if (e.kind === "absent" || e.kind === "exists") {
		bindingLeaves(e.bindings, into)
		sourceLeaves(e.source, into)
	} else {
		for (const c of exprChildren(e)) {
			exprLeaves(c.term, into)
		}
	}
}

/** The leaves one expression reads in its own scope (`exprLeaves`). */
export const leavesOf = <P extends object, T>(
	e: ExprDesc<Located, ParamsAs<P, T>>
): Leaves<P, T> => {
	const into = emptyLeaves<P, T>()
	exprLeaves(e, into)
	return into
}

const bindingLeaves = <P extends object, T>(
	bindings: BindingsDesc<Located, ParamsAs<P, T>>,
	into: Leaves<P, T>
): void => {
	for (const [, e] of entries(bindings)) {
		exprLeaves(e, into)
	}
}

/**
 * A source's bind map is evaluated in the importing rule's scope, the bind map of each query's rows it binds a relation
 * parameter to among it, and so is each argument of a call: a value's term, and a rows argument's bind map, its query
 * its own scope.
 */
const sourceLeaves = <P extends object, T>(
	s: SourceDesc<Located, ParamsAs<P, T>>,
	into: Leaves<P, T>
): void => {
	const bound = (bind: BindMapDesc<Located, ParamsAs<P, T>>): void => {
		for (const [, b] of entries(bind)) {
			if (b.kind === "relationParam") {
				into.params.push(b)
			} else if (b.kind === "rows") {
				bound(b.bind)
			} else {
				exprLeaves(b, into)
			}
		}
	}
	if (s.kind === "query" || s.kind === "step") {
		bound(s.bind)
	} else if (s.kind === "call" || s.kind === "callField") {
		for (const [, a] of entries(s.args)) {
			if (a.kind === "rows") {
				bound(a.bind)
			} else {
				exprLeaves(a, into)
			}
		}
	} else if (s.kind === "split") {
		for (const a of Object.values(s.args)) {
			exprLeaves(a, into)
		}
	}
}

const headLeaves = <P extends object, T>(
	h: HeadTermDesc<Located, ParamsAs<P, T>>,
	into: Leaves<P, T>
): void => {
	for (const e of headTerms(h)) {
		exprLeaves(e, into)
	}
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

/** A relational filter of a rule: a negation (`absent`), or an existence (`exists`), its positive twin. */
export type RelationalFilter = Extract<ResolvedExpr, { readonly kind: "absent" | "exists" }>

/** Whether `e` is a relational filter (RelationalFilter). */
const isRelational = (e: ResolvedExpr): e is RelationalFilter =>
	e.kind === "absent" || e.kind === "exists"

/**
 * Splits a rule's filters into its scalar predicates and its relational filters, its negations and existences: each is
 * a rule-level filter, found at the top of a filter or inside a top-level conjunction.
 */
export const splitWhere = (
	where: ReadonlyArray<ResolvedExpr>
): {
	readonly scalar: ReadonlyArray<readonly [number, ResolvedExpr]>
	readonly relational: ReadonlyArray<readonly [number, RelationalFilter]>
} => {
	const scalar: Array<readonly [number, ResolvedExpr]> = []
	const relational: Array<readonly [number, RelationalFilter]> = []
	const visit = (i: number, e: ResolvedExpr): void => {
		if (isRelational(e)) {
			relational.push([i, e])
		} else if (e.kind === "and" && e.args.some((a) => isRelational(a) || a.kind === "and")) {
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
	return { scalar, relational }
}
