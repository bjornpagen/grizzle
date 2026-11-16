/** What the properties of transform.test.ts read: its spaces, models and helpers. */

import type { Expr, SqlStatement } from "#compiler/sql/ast.ts"
import { lit, types } from "#compiler/sql/build.ts"
import {
	identityHooks,
	inertVisitor,
	transformStatement,
	visitSelect
} from "#compiler/sql/transform.ts"

/** Whether an expression is a leaf: a literal, a column or a parameter. */
const isLeaf = (e: Expr): boolean =>
	e.kind === "literal" || e.kind === "column" || e.kind === "param"

/** The leaves of a statement in traversal order: the visitor's for a query, the rewrite's own for any other kind. */
export const leaves = (s: SqlStatement): ReadonlyArray<Expr> => {
	const out: Array<Expr> = []
	if (s.kind === "select") {
		visitSelect(s, { ...inertVisitor, expr: (e) => (isLeaf(e) ? void out.push(e) : undefined) })
	} else {
		transformStatement(s, {
			...identityHooks,
			expr: (e) => {
				if (isLeaf(e)) {
					out.push(e)
				}
				return e
			}
		})
	}
	return out
}

/** The literal a rewrite puts at the one leaf it changes. */
export const marker = lit.text("rewritten", types.text)
