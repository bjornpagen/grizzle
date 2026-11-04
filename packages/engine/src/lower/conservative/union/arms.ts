import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Heading, RelNode } from "#compiler/ir/rel.ts"
import { isRefined } from "#compiler/ir/scalar.ts"
import {
	type ColumnMap,
	columnIn,
	type Env,
	type LowerContext
} from "#compiler/lower/conservative/context.ts"

import type { Expr, Select, SelectCore, SetOperator, Target, TypeRef } from "#compiler/sql/ast.ts"
import { cast, core, sameTypeRef, select, setOp, target, unitTargets } from "#compiler/sql/build.ts"

/**
 * An expression delivered at `type`: unchanged when it already carries that type explicitly (a typed literal, a typed
 * parameter or a cast), otherwise cast to it.
 */
const typedAs = (e: Expr, type: TypeRef): Expr =>
	(e.kind === "literal" || e.kind === "param" || e.kind === "cast") && sameTypeRef(e.type, type)
		? e
		: cast(e, type)

/**
 * The targets of one set-operation arm, read from its column map in `heading` order: a refined column cast to its
 * base type in every arm, any other column as it is.
 *
 * Set-operation arms (UNION arms rename their columns position by position to the union's names).
 *
 * Each arm is read as a derived table and selected in the operation's heading order, by column name, so arms whose
 * headings list the same columns in different orders line up, and an arm that is a full query with its own clauses
 * never merges its ORDER BY or LIMIT into the set operation. A set-operation arm carries no aliases: the
 * operation takes its left arm's names, and the consumer renames positionally through its own column list.
 *
 * Every arm delivers each column at one explicit PostgreSQL type, so the operation never resolves a common type across
 * its arms. An unrefined column is its base type in every arm already. A refined column is
 * not: an arm reading a stored refined field delivers its domain, while an arm of a literal, a VALUES or recordset
 * column or a recursive state delivers the base type. Every arm therefore casts a refined column to its
 * base type, which is the type literals and recursive state use; the cast of a domain to its base is a binary-compatible
 * relabel, which PostgreSQL strips when it matches an index, and it is never a cast of a column to its own type.
 */
export const armTargets = (
	cx: LowerContext,
	heading: Heading,
	map: ColumnMap
): NonEmptyReadonlyArray<Target> => armColumns(cx, heading, map).targets

/** One arm's targets (armTargets) and the expression each delivers, by its column of `heading`. */
export const armColumns = (
	cx: LowerContext,
	heading: Heading,
	map: ColumnMap
): { readonly targets: NonEmptyReadonlyArray<Target>; readonly delivered: ColumnMap } => {
	const columns = heading.map((c): readonly [string, Expr] => {
		const e = columnIn(map, c.name)
		return [c.name, isRefined(c.type) ? typedAs(e, cx.baseTypeRef(c.type)) : e]
	})
	return {
		targets: isNonEmpty(columns) ? mapNonEmpty(columns, ([, e]) => target(e)) : unitTargets,
		delivered: new Map(columns)
	}
}

/** One arm, projected onto `heading` in its order. */
export const armCore = (cx: LowerContext, arm: RelNode, heading: Heading, env: Env): SelectCore => {
	const source = cx.source(arm, env)
	return core(armTargets(cx, heading, source.map), [source.item], undefined)
}

/** arm1 <op> arm2 <op> ..., left-associated: one set operation of every arm. */
export const setOperation = (op: SetOperator, arms: NonEmptyReadonlyArray<SelectCore>): Select =>
	select(setOp(op, arms))
