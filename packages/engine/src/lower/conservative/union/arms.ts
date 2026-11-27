import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import type { Heading, RelNode } from "#compiler/ir/rel.ts"
import { isRefined, type ScalarType } from "#compiler/ir/scalar.ts"
import {
	type ColumnMap,
	columnIn,
	type Env,
	type LowerContext,
	readsSet
} from "#compiler/lower/conservative/context.ts"
import type { Expr, Select, SelectCore, Target, TypeRef } from "#compiler/sql/ast.ts"
import {
	cast,
	core,
	provedCore,
	sameTypeRef,
	select,
	setBodyOf,
	setOp,
	target,
	unitTargets
} from "#compiler/sql/build.ts"

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
 * Every arm delivers each column at one explicit PostgreSQL type, its heading type's base, so the operation never
 * resolves a common type across its arms and PostgreSQL's type of every column is that base. An arm delivers a column at
 * another type where the column is refined or the arm delivers a refined value under it: an arm reading a stored refined
 * field delivers its domain, while an arm of a literal, a VALUES or input array column or a recursive state delivers the
 * base type, and an arm's term a type subsumes stands bare under it (ir/scalar.ts subsumes: a domain's value under its
 * base's column), so PostgreSQL resolves arms of one domain to that domain and arms of two refinements of one base to the
 * base. An arm whose column is refined, or delivers a refined value (deliveredType), therefore casts it to the base type,
 * which the type literals and recursive state use; the cast of a domain to its base is a binary-compatible relabel, which
 * PostgreSQL strips when it matches an index, printed at the boundary alone, never a node a walk reads.
 */
export const armTargets = (
	cx: LowerContext,
	heading: Heading,
	arm: RelNode,
	map: ColumnMap
): NonEmptyReadonlyArray<Target> => armColumns(cx, heading, arm, map).targets

/**
 * The type an arm delivers its column `name` at in PostgreSQL: a projection's term's, a column it reads read through to
 * the column it names in its input, a filter's input's, and any other node's heading type, which its terms carry.
 */
const deliveredType = (node: RelNode, name: string, heading: ScalarType): ScalarType => {
	if (node.kind === "ProjectSet") {
		const out = node.out.find((o) => o.name === name)
		if (out === undefined) {
			return heading
		}
		const term = out.expr
		return term.kind === "column" && term.column.node === node.input.id
			? deliveredType(node.input, term.column.name, term.type)
			: term.pgType
	}
	if (node.kind === "Filter") {
		return deliveredType(node.input, name, heading)
	}
	return node.heading.find((c) => c.name === name)?.type ?? heading
}

/** One arm's targets (armTargets) and the expression each delivers, by its column of `heading`. */
export const armColumns = (
	cx: LowerContext,
	heading: Heading,
	arm: RelNode,
	map: ColumnMap
): { readonly targets: NonEmptyReadonlyArray<Target>; readonly delivered: ColumnMap } => {
	const columns = heading.map((c): readonly [string, Expr] => {
		const e = columnIn(map, c.name)
		return [
			c.name,
			isRefined(c.type) || isRefined(deliveredType(arm, c.name, c.type))
				? typedAs(e, cx.baseTypeRef(c.type))
				: e
		]
	})
	return {
		targets: isNonEmpty(columns) ? mapNonEmpty(columns, ([, e]) => target(e)) : unitTargets,
		delivered: new Map(columns)
	}
}

/**
 * One arm, projected onto `heading` in its order: every column of the arm, so its rows are the arm's, a set keyed by
 * its heading when the arm's query is one, and an operand of the set operation when the arm's rows may repeat.
 */
export const armCore = (cx: LowerContext, arm: RelNode, heading: Heading, env: Env): SelectCore => {
	const source = cx.source(arm, env)
	const targets = armTargets(cx, heading, arm, source.map)
	return readsSet(source.item)
		? provedCore("keyed", targets, [source.item], undefined)
		: core(targets, [source.item], undefined)
}

/** arm1 <op> arm2 <op> ..., left-associated: one set operation of every arm. */
export const setOperation = (
	op: "UNION" | "INTERSECT" | "EXCEPT",
	arms: NonEmptyReadonlyArray<SelectCore>
): Select =>
	select(setBodyOf(setOp(op, arms), "a set operation over at least two arms, or one set arm"))
