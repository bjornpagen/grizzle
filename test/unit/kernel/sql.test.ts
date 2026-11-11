/**
 * The SQL kernel's test vocabulary: the query and statement generators (test/support/kernel/sqlgen.ts), the shape
 * (test/support/kernel/shape.ts) and the one-hole walker, each over generated SQL.
 *
 * - Every generated query passes the statement audit, and every generated statement passes the statement audit over
 *   its AST and the text audit over its print. Oracle: the audits (test/support/oracle/verify/sql.ts), the SQL rules
 *   grizzle's statements keep, a specification turned into a checker.
 * - A query's shape is the same under a renaming of every alias. Oracle: the metamorphic relation itself.
 * - The root hole's rewrites come first, of kind "statement" at site 0, exactly the variant, and no other site is of
 *   that kind; every other rewrite changes exactly one site, rebuilding only the path to it and sharing every other
 *   node. Oracle: the walker's contract, checked by counting the marker and the fresh objects.
 *
 * Features: the clauses the query generator has; every statement kind and every construct an audit rule watches (kept
 * cases plant the ones the generator draws a few times a run); a relation alias renamed; each statement kind the root
 * hole sees.
 *
 * Plants (~/.cache/grizzle-release/BR06/plants): sql-print-quote-unescaped (a quote inside an identifier printed
 * bare), sql-shape-alias-sensitive (a shape that reads an alias's length), sql-onehole-root-unmarked (the root's
 * rewrites given another kind) and sql-onehole-replaces-past-site (every site from the hole on replaced).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { regex } from "arkregex"
import { Array as Arr, Effect, Formatter, Record } from "effect"
import type {
	Cte,
	Delete,
	Expr,
	Insert,
	Merge,
	SelectCore,
	SqlStatement,
	Update
} from "#compiler/sql/ast.ts"

import {
	asc,
	call,
	col,
	core,
	cte,
	cteRefAs,
	eq,
	lit,
	mapTargets,
	objectName,
	operandSelect,
	provedCore,
	select,
	table,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import {
	featureCount,
	type ShapeFeature,
	shapeFeatures,
	shapeOf
} from "#test/support/kernel/shape.ts"

import {
	noHoles,
	oneHole,
	type SqlCatalog,
	selectGen,
	statementGen
} from "#test/support/kernel/sqlgen.ts"

import { caseHang } from "#test/support/limits.ts"
import {
	auditStatement,
	auditStatementViolations,
	auditTextViolations
} from "#test/support/oracle/verify/sql.ts"
import { unitCarrierName } from "#test/support/sql.ts"

const catalog: SqlCatalog = [
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
const statementCatalog: SqlCatalog = [
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
const admitted = (statement: SqlStatement): void => {
	const found = Arr.map(
		auditStatementViolations(statement),
		(v) => `${v.rule} at ${v.where}: ${v.detail}`
	)
	const text = printStatement(statement)
	assert.deepEqual(found, [], text)
	assert.deepEqual(
		Arr.map(auditTextViolations(text), (v) => `${v.rule} at ${v.where}: ${v.detail}`),
		[],
		text
	)
}

/** What a generated statement notes: its kind, and its shape's features. */
type StatementFeature = ShapeFeature | `statement ${SqlStatement["kind"]}`

/** The forms the statement generator must reach: every statement kind, and the constructs each audit rule watches. */
const requiredStatementFeatures: Arr.NonEmptyReadonlyArray<StatementFeature> = [
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
	"in query",
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

const textCore = (relation: string, column: string, alias: string): SelectCore =>
	core([targetAs(col(alias, column), "c1")], [table("kernel", relation, alias)], undefined)

const readingWrite = (write: Insert | Update | Delete | Merge): SqlStatement => {
	const written: Cte = cte("r2", [], write)
	return {
		...select(
			provedCore("keyed", [targetAs(col("r3", "c1"), "c1")], [cteRefAs("r2", "r3")], undefined)
		),
		with: { recursive: false, ctes: [written] }
	}
}

/**
 * Planted: statements of the constructs the generator draws a few times a run, written over the statement catalog.
 * A grouped core with a sum and an ordered-set mode; a chain of UNION ALL, INTERSECT and EXCEPT; and a query reading a
 * data-modifying CTE of each write kind, named by its RETURNING alias.
 */
const keptStatements: ReadonlyArray<Kept<SqlStatement, StatementFeature>> = (() => {
	const order = objectName("kernel", "order")
	return [
		{
			note: "a sum and a mode per group",
			draws: "",
			sketch: select({
				kind: "core",
				distinct: false,
				rows: "grouped",
				targets: [
					targetAs(col("r1", "select"), "c1"),
					targetAs(call("sum", [col("r1", "amount")]), "c2"),
					targetAs({ ...call("mode", []), withinGroup: [asc(col("r1", "is null"))] }, "c3")
				],
				from: [table("kernel", "order", "r1")],
				where: undefined,
				groupBy: [col("r1", "select")],
				having: undefined
			}),
			reaches: ["statement select", "group by", "aggregate sum", "aggregate mode"]
		},
		{
			note: "UNION ALL, then INTERSECT, then EXCEPT",
			draws: "",
			sketch: select({
				kind: "setOp",
				op: "EXCEPT",
				arms: [
					select({
						kind: "setOp",
						op: "INTERSECT",
						arms: [
							operandSelect({
								kind: "setOp",
								op: "UNION ALL",
								rows: "operand",
								arms: [textCore("tag", "label", "r1"), textCore("order", "select", "r2")]
							}),
							textCore("line item", 'say "hi"', "r3")
						]
					}),
					textCore("tag", "label", "r4")
				]
			}),
			reaches: ["union all", "intersect", "except"]
		},
		{
			note: "a query reading the rows an INSERT returns",
			draws: "",
			sketch: readingWrite({
				kind: "insert",
				with: undefined,
				table: objectName("kernel", "tag"),
				alias: "r1",
				columns: ["label"],
				overriding: undefined,
				source: { kind: "values", rows: [[lit.text("planted", types.text)]] },
				onConflict: undefined,
				returning: [targetAs(col("r1", "label"), "c1")]
			}),
			reaches: ["with", "cte insert"]
		},
		{
			note: "a query reading the rows an UPDATE returns",
			draws: "",
			sketch: readingWrite({
				kind: "update",
				with: undefined,
				table: order,
				alias: "r1",
				set: [{ column: "amount", value: col("r1", "amount") }],
				from: [],
				where: col("r1", "is null"),
				returning: [targetAs(col("r1", "id"), "c1")]
			}),
			reaches: ["with", "cte update"]
		},
		{
			note: "a query reading the rows a DELETE returns",
			draws: "",
			sketch: readingWrite({
				kind: "delete",
				with: undefined,
				table: order,
				alias: "r1",
				using: [],
				where: undefined,
				returning: [targetAs(col("r1", "id"), "c1")]
			}),
			reaches: ["with", "cte delete"]
		},
		{
			note: "a query reading the rows a MERGE returns",
			draws: "",
			sketch: readingWrite({
				kind: "merge",
				with: undefined,
				table: order,
				alias: "r1",
				using: table("kernel", "line item", "r4"),
				on: eq(col("r1", "id"), col("r4", "order")),
				whens: [{ match: "MATCHED", condition: undefined, action: { kind: "delete" } }],
				returning: [targetAs(col("r1", "id"), "c1")]
			}),
			reaches: ["with", "cte merge"]
		}
	]
})()

/** An alias r<n> or c<n> renamed r<n+100> or c<n+100>; any other name as it is. */
const bump = (name: string): string => {
	const [, letter, n] = regex("^([rc])(\\d+)$").exec(name) ?? []
	return letter === undefined || n === undefined ? name : `${letter}${Number(n) + 100}`
}

/** Every relation alias r<n> renamed r<n+100> and every column alias c<n> renamed c<n+100>: the same query. */
const renamed = (statement: SqlStatement): SqlStatement =>
	transformStatement(statement, {
		...identityHooks,
		expr: (e) =>
			e.kind === "column" && e.table !== undefined ? { ...e, table: bump(e.table) } : e,
		fromSource: (item) => (item.kind === "table" ? { ...item, alias: bump(item.alias) } : item),
		core: (c) => mapTargets(c, (t) => (t.alias === undefined ? t : { ...t, alias: bump(t.alias) }))
	})

describe("generated queries", () => {
	it.effect(
		"pass every rule of the statement audit and reach every clause the generator has",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "specification", name: "the statement audit" },
						suite: "unit/kernel/sqlgen-audit",
						draw: drawn(selectGen(catalog)),
						literal: Formatter.format,
						coverage: required<ShapeFeature>(
							[
								"from table",
								"join",
								"union all",
								"distinct",
								"order by",
								"limit param",
								"count(*)"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(query, c) =>
						Effect.sync(() => {
							succeeded(auditStatement(query), printStatement(query))
							c.noteAll(shapeFeatures(shapeOf(query)))
						})
				)
			)
	)

	it.effect("keep their shape under a renaming of every alias", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "universal", name: "a shape is invariant under renaming every alias" },
					suite: "unit/kernel/shape-renaming",
					draw: drawn(selectGen(catalog)),
					literal: Formatter.format,
					coverage: required<"a relation alias renamed">(["a relation alias renamed"], {
						cases: 200,
						sense: notesOnly
					}),
					kept: [],
					runs: 200,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(query, c) =>
					Effect.sync(() => {
						if (featureCount(shapeOf(query), "from table") > 0) {
							c.note("a relation alias renamed")
						}
						assert.deepEqual(shapeOf(renamed(query)), shapeOf(query))
					})
			)
		)
	)
})

describe("generated statements", () => {
	it.effect(
		"pass both audits and reach every statement kind and every construct an audit rule watches",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "specification", name: "the statement audit and the text audit" },
						suite: "unit/kernel/statement-audit",
						draw: drawn(statementGen(statementCatalog)),
						literal: Formatter.format,
						coverage: required<StatementFeature>(requiredStatementFeatures, {
							cases: 4000,
							sense: notesOnly
						}),
						kept: keptStatements,
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(statement, c) =>
						Effect.sync(() => {
							admitted(statement)
							const shape = shapeOf(statement)
							c.note(`statement ${shape.statement}`)
							c.noteAll(shapeFeatures(shape))
						})
				)
			)
	)
})

/**
 * The root hole's contract: its variants are the walk's first rewrites, of kind "statement" at site 0, each exactly
 * the variant, and no other site is of that kind.
 */
const rootHoleFirst = (statement: SqlStatement): void => {
	const variant: SqlStatement = { kind: "analyze", carriers: [unitCarrierName(1)] }
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
const oneSiteEach = (query: SqlStatement, marker: Expr): number => {
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

describe("the one-hole walker", () => {
	it.effect("lists the root statement's rewrites first", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "specification", name: "the root hole's contract" },
					suite: "unit/kernel/root-hole",
					draw: drawn(statementGen(statementCatalog)),
					literal: Formatter.format,
					coverage: required<StatementFeature>(
						[
							"statement select",
							"statement insert",
							"statement update",
							"statement delete",
							"statement merge"
						],
						{ cases: 400, sense: notesOnly }
					),
					kept: [],
					runs: 100,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(statement, c) =>
					Effect.sync(() => {
						rootHoleFirst(statement)
						c.note(`statement ${shapeOf(statement).statement}`)
					})
			)
		)
	)

	it.effect(
		"changes exactly one site per rewrite, rebuilding only the path to it and sharing every other node",
		(ctx) => {
			const marker: Expr = lit.int(424242, types.integer)
			return searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the marker at one site, and the fresh objects along one path"
						},
						suite: "unit/kernel/one-hole",
						draw: drawn(selectGen(catalog)),
						literal: Formatter.format,
						coverage: required<"a literal rewritten">(["a literal rewritten"], {
							cases: 200,
							sense: notesOnly
						}),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(query, c) =>
						Effect.sync(() => {
							if (oneSiteEach(query, marker) > 0) {
								c.note("a literal rewritten")
							}
						})
				)
			)
		}
	)
})
