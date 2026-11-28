/** What the properties of sql.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { regex } from "arkregex"
import { Array as Arr, Record } from "effect"
import type { Expr, SqlStatement } from "#compiler/sql/ast.ts"
import { lit, mapTargets, types } from "#compiler/sql/build.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { featureCount, type ShapeFeature, shapeOf } from "#test/support/kernel/shape.ts"
import { noHoles, oneHole, type SqlCatalog } from "#test/support/kernel/sqlgen.ts"
import {
	auditStatementViolations,
	auditTextViolations,
	guardedTermsOf
} from "#test/support/oracle/verify/sql.ts"

export const catalog: SqlCatalog = [
	{
		schema: "kernel",
		name: "task",
		columns: [
			{ name: "id", type: "bigint" },
			{ name: "title", type: "text" },
			{ name: "done", type: "boolean" }
		]
	},
	{
		schema: "kernel",
		name: "note",
		columns: [
			{ name: "id", type: "bigint" },
			{ name: "weight", type: "numeric" },
			{ name: "rank", type: "integer" }
		]
	}
]

/**
 * The catalog of the statement generator: a table's first column is its key. Its names are words SQL reserves and
 * spellings only quoting keeps names, so the text audit must tell them from SQL.
 */
export const statementCatalog: SqlCatalog = [
	{
		schema: "kernel",
		name: "order",
		columns: [
			{ name: "id", type: "bigint" },
			{ name: "select", type: "text" },
			{ name: "is null", type: "boolean" },
			{ name: "amount", type: "numeric" }
		]
	},
	{
		schema: "kernel",
		name: "line item",
		columns: [
			{ name: "id", type: "bigint" },
			{ name: "order", type: "bigint" },
			{ name: "rank", type: "integer" },
			{ name: 'say "hi"', type: "text" }
		]
	},
	{ schema: "kernel", name: "tag", columns: [{ name: "label", type: "text" }] }
]

/** Both audits admit the statement: the statement audit over its AST, the text audit over its print. */
export const admitted = (statement: SqlStatement): void => {
	const found = Arr.map(
		auditStatementViolations(statement),
		(v) => `${v.rule} at ${v.where}: ${v.detail}`
	)
	const text = printStatement(statement)
	assert.deepEqual(found, [], text)
	assert.deepEqual(
		Arr.map(
			auditTextViolations(text, guardedTermsOf(statement)),
			(v) => `${v.rule} at ${v.where}: ${v.detail}`
		),
		[],
		text
	)
}

/** What a generated statement notes: its kind, and its shape's features. */
export type AuditedStatementFeature = ShapeFeature | `statement ${SqlStatement["kind"]}`

/** The forms the statement generator must reach: every statement kind, and the constructs each audit rule watches. */
export const requiredStatementFeatures: Arr.NonEmptyReadonlyArray<AuditedStatementFeature> = [
	"statement select",
	"statement insert",
	"statement update",
	"statement delete",
	"statement merge",
	"with",
	"with recursive",
	"cte materialized",
	"cte insert",
	"cte update",
	"cte delete",
	"cte merge",
	"from derived",
	"from values",
	"from arrays",
	"from cte",
	"lateral",
	"join",
	"cross join",
	"group by",
	"having",
	"distinct",
	"distinct on",
	"order by",
	"limit param",
	"limit literal",
	"union",
	"union all",
	"intersect",
	"except",
	"exists",
	"scalar subquery",
	"in list",
	"between",
	"case",
	"count(*)",
	"aggregate sum",
	"aggregate mode",
	"window row_number",
	"window lead",
	"derived of no column",
	"function of no column",
	"arrays of no column",
	"cte of no column",
	"core of no target",
	"insert of no column"
]

/** An alias r<n> or c<n> renamed r<n+100> or c<n+100>; any other name as it is. */
const bump = (name: string): string => {
	const [, letter, n] = regex("^([rc])(\\d+)$").exec(name) ?? []
	return letter === undefined || n === undefined ? name : `${letter}${Number(n) + 100}`
}

/** Every relation alias r<n> renamed r<n+100> and every column alias c<n> renamed c<n+100>: the same query. */
export const renamed = (statement: SqlStatement): SqlStatement =>
	transformStatement(statement, {
		...identityHooks,
		expr: (e) =>
			e.kind === "column" && e.table !== undefined ? { ...e, table: bump(e.table) } : e,
		fromSource: (item) => (item.kind === "table" ? { ...item, alias: bump(item.alias) } : item),
		core: (c) => mapTargets(c, (t) => (t.alias === undefined ? t : { ...t, alias: bump(t.alias) }))
	})

/**
 * The root hole's contract: its variants are the walk's first rewrites, of kind "statement" at site 0, each exactly
 * the variant, and no other site is of that kind.
 */
export const rootHoleFirst = (statement: SqlStatement): void => {
	const variant: SqlStatement = { kind: "commit" }
	const marker = lit.int(424243, types.integer)
	const rewrites = oneHole(statement, {
		...noHoles,
		statement: () => [variant],
		expr: (e) => (e.kind === "literal" ? [marker] : [])
	})
	const [first, ...rest] = rewrites
	assert.ok(first !== undefined, "the root hole gives a rewrite")
	assert.deepEqual([first.kind, first.site], ["statement", 0])
	assert.equal(first.statement, variant)
	assert.equal(Arr.filter(rest, (r) => r.kind === "statement").length, 0)
}

/** The values an object holds, and every object a value reaches. */
const childrenOf = (o: object): ReadonlyArray<unknown> => Record.values(o)
const reachable = (root: unknown): ReadonlySet<object> => {
	const seen = new Set<object>()
	const walk = (value: unknown): void => {
		if (typeof value !== "object" || value === null || seen.has(value)) {
			return
		}
		seen.add(value)
		for (const child of childrenOf(value)) {
			walk(child)
		}
	}
	walk(root)
	return seen
}

/**
 * The one-hole walker's locality over a query: one rewrite per literal, each holding the marker at exactly one site and
 * the query's relations, and rebuilding only the path from the root to its site, sharing every other node.
 */
export const oneSiteEach = (query: SqlStatement, marker: Expr): number => {
	let literals = 0
	transformStatement(query, {
		...identityHooks,
		expr: (e) => {
			if (e.kind === "literal") {
				literals++
			}
			return e
		}
	})
	const rewrites = oneHole(query, {
		...noHoles,
		expr: (e) => (e.kind === "literal" ? [marker] : [])
	})
	assert.equal(rewrites.length, literals)
	for (const rewrite of rewrites) {
		let markers = 0
		transformStatement(rewrite.statement, {
			...identityHooks,
			expr: (e) => {
				if (e === marker) {
					markers++
				}
				return e
			}
		})
		assert.equal(markers, 1, `rewrite of site ${rewrite.site}`)
		assert.equal(
			featureCount(shapeOf(rewrite.statement), "from table"),
			featureCount(shapeOf(query), "from table")
		)
		/**
		 * The objects the rewrite holds that neither the query nor the marker held form one chain: the path
		 * from the root to the site, each holding at most one other new object.
		 */
		const held = new Set([...reachable(query), ...reachable(marker)])
		const fresh = new Set(Arr.filter([...reachable(rewrite.statement)], (o) => !held.has(o)))
		for (const o of fresh) {
			assert.ok(
				Arr.filter(
					childrenOf(o),
					(child) => typeof child === "object" && child !== null && fresh.has(child)
				).length <= 1,
				`rewrite of site ${rewrite.site} rebuilds beside its path`
			)
		}
	}
	return rewrites.length
}

/** The literal the one-hole walker's locality property writes at each site. */
export const marker: Expr = lit.int(424242, types.integer)
