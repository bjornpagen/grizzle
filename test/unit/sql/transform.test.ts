import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import type { Expr, SqlStatement } from "#compiler/sql/ast.ts"
import { lit, types } from "#compiler/sql/build.ts"
import {
	identityHooks,
	inertVisitor,
	transformStatement,
	visitSelect
} from "#compiler/sql/transform.ts"
import { assert } from "#test/support/assert.ts"
import { statementGen } from "#test/support/kernel/sqlgen.ts"
import { caseHang } from "#test/support/limits.ts"
import { sqlCatalog } from "#test/unit/sql/audit/catalog.ts"

/**
 * The SQL AST traversals (packages/engine/src/sql/transform.ts), over generated statements of every kind: a traversal that
 * changes nothing keeps the statement's identity, and a rewrite that changes a single leaf, wherever it sits, comes back
 * at that leaf's place and nowhere else, so no node keeps its old form after a child changed. For a query the visitor
 * is the second traversal the rewrite is checked against.
 */
const isLeaf = (e: Expr): boolean =>
	e.kind === "literal" || e.kind === "column" || e.kind === "param"

/** The leaves of a statement in traversal order: the visitor's for a query, the rewrite's own for any other kind. */
const leaves = (s: SqlStatement): ReadonlyArray<Expr> => {
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

const marker = lit.text("rewritten", types.text)

describe("the SQL AST traversals", () => {
	it.effect(
		"keep an unchanged statement, and rebuild exactly the changed leaf of every generated statement",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/sql/transform-leaf",
						draw: drawn(statementGen(sqlCatalog)),
						literal: Formatter.format,
						coverage: required<`statement ${SqlStatement["kind"]}`>(
							[
								"statement select",
								"statement insert",
								"statement update",
								"statement delete",
								"statement merge"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
						Effect.sync(() => {
							assert.equal(transformStatement(s, identityHooks), s)
							const before = leaves(s)
							for (const leaf of new Set(before)) {
								const rewritten = transformStatement(s, {
									...identityHooks,
									expr: (rebuilt, original) => (original === leaf ? marker : rebuilt)
								})
								assert.deepEqual(
									Arr.map(leaves(rewritten), (e) => e === marker),
									Arr.map(before, (e) => e === leaf)
								)
							}
							c.note(`statement ${s.kind}`)
						})
				)
			)
	)
})
