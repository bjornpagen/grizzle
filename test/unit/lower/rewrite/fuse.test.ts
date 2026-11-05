import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { nodesByLabel } from "#compiler/ir/dag.ts"
import type { ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import type { Pass } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { conservativeMeta, type RelDag } from "#compiler/ir/rel.ts"
import {
	relationalRewrites,
	semanticSimplification
} from "#compiler/lower/optimize/demand/phases.ts"
import { fusePass } from "#compiler/lower/optimize/fuse/index.ts"
import { simplifyPass } from "#compiler/lower/optimize/simplify/index.ts"
import { assert, contains, succeeded } from "#test/support/assert.ts"
import {
	Account,
	Posting,
	plainRegion,
	Q,
	T,
	uuidOf
} from "#test/unit/lower/conservative/fixtures.ts"

import { caseHang } from "#test/support/limits.ts"
import {
	passContext,
	deliversAlikeOn,
	factSubsets,
	ledgerCatalog,
	lowersConservatively,
	outerCol,
	queryOf,
	type Ran,
	rulesOf,
	runPasses
} from "#test/unit/lower/rewrite/support.ts"

/**
 * R01 fusion: an imported stage written as a region under filters and renames is inlined into the region that matches
 * it, preserving the complete bound tuple and every aggregate boundary, with the (account, amount) versus (id, account,
 * amount) counterexample held to the reference; a boundary, a correlated stage or two constants on one inner variable
 * is never fused.
 */

const u = (n: number): TypedLiteral => ({ kind: "uuid", value: uuidOf(n) })
const i8 = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })
const text = (s: string): TypedLiteral => ({ kind: "text", value: s })

/**
 * Every database of these posting and account facts: account 10 holds amounts 5, 5 and 7 (two postings agreeing on
 * (account, amount)), account 11 one 5.
 */
const databases = factSubsets({
	Posting: [
		[u(1), u(10), i8(5)],
		[u(2), u(10), i8(5)],
		[u(3), u(10), i8(7)],
		[u(4), u(11), i8(5)]
	],
	Account: [
		[u(10), text("a")],
		[u(11), text("b")]
	]
})

/**
 * Runs fusion and simplification, and the semantic simplification and relational rewrites composed, holding each to
 * every database's delivery and to the conservative lowering; the fusion run's certificates.
 */
const fused = (dag: RelDag): Ran => {
	const query = queryOf(dag, [])
	const run = (passes: ReadonlyArray<Pass<LogicalQuery, LogicalQuery>>): Ran => {
		const ran = succeeded(
			runPasses(query, passes, passContext({ catalog: ledgerCatalog, evidence: "snapshot" }))
		)
		deliversAlikeOn(databases, [Posting, Account], [], query, ran.query)
		lowersConservatively(ran.query, emptyCodebook)
		return ran
	}
	run([semanticSimplification, relationalRewrites])
	return run([fusePass, simplifyPass])
}

const postings = (q: Q) =>
	q.region([
		{
			source: q.base(Posting, conservativeMeta),
			bind: { id: "id", account: "account", amount: "amount" },
			constants: {}
		}
	])

describe("the complete bound tuple survives fusion", () => {
	it.effect(
		"a fold over an imported stage keeps its bound tuple, (account, amount) or (id, account, amount), through fusion",
		(ctx) => {
			type Bound = "account, amount" | "id, account, amount"
			type Reader = "a fold" | "the query"
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/rewrite/fuse-bound-tuple",
						literal: Formatter.format,
						generator: (source) =>
							[
								source.draw(element<Bound>(["account, amount", "id, account, amount"])),
								source.draw(element<Reader>(["a fold", "the query"]))
							] as const,
						limit: 4,
						coverage: requiredInSpace<`${Bound} read by ${Reader}`>([
							"account, amount read by a fold",
							"account, amount read by the query",
							"id, account, amount read by a fold",
							"id, account, amount read by the query"
						]),
						caseHang
					},
					([bound, reader], c) =>
						Effect.sync(() => {
							c.note(`${bound} read by ${reader}`)
							const columns =
								bound === "account, amount" ? ["account", "amount"] : ["id", "account", "amount"]
							const q = new Q()
							const imported = q.project(
								postings(q),
								Arr.map(columns, (col) => [col, col] as const),
								conservativeMeta
							)
							const outer = q.region([
								{
									source: imported,
									bind: Rec.fromEntries(Arr.map(columns, (col) => [col, col])),
									constants: {}
								}
							])
							if (reader === "the query") {
								contains(rulesOf(fused(q.build(outer).dag).certificates), "R01.fusion")
								return
							}
							const group = q.group(
								outer,
								columns,
								["account"],
								[
									{ name: "total", fn: "sum", op: "sum(bigint)", args: ["amount"], type: T.numeric }
								],
								conservativeMeta
							)
							const ran = fused(
								q.build(
									q.project(
										group,
										[
											["account", "account"],
											["total", "total"]
										],
										conservativeMeta
									)
								).dag
							)
							contains(rulesOf(ran.certificates), "R01.fusion")
							const g = nodesByLabel(ran.query.dag).get(group.id)
							assert.deepEqual(g?.kind === "Group" ? g.bound.columns : [], columns)
						})
				)
			)
		}
	)
})

/**
 * What an outer occurrence does with each of two columns of an imported stage that carry one inner variable (amount):
 * leave it existential, bind it to a variable of its own, or fix it to 5 or to 7.
 */
type Use = "existential" | "bound" | "fixed to 5" | "fixed to 7"

const uses = element<Use>(["existential", "bound", "fixed to 5", "fixed to 7"])

describe("fixed columns in R01 fusion", () => {
	it.effect(
		"two columns carrying one inner variable fuse unless one is fixed and the other fixed or bound",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/rewrite/fuse-fixed-columns",
						literal: Formatter.format,
						generator: (source) => [source.draw(uses), source.draw(uses)] as const,
						limit: 16,
						coverage: requiredInSpace<"fused" | "refused">(["fused", "refused"]),
						caseHang
					},
					([first, second], c) =>
						Effect.sync(() => {
							const q = new Q()
							const imported = q.project(
								postings(q),
								[
									["id", "id"],
									["a1", "amount"],
									["a2", "amount"]
								],
								conservativeMeta
							)
							const bind: Record<string, string> = { id: "task" }
							const fixed: Record<string, ScalarExpr> = {}
							for (const [column, use] of [
								["a1", first],
								["a2", second]
							] as const) {
								if (use === "bound") {
									bind[column] = column
								}
								if (use === "fixed to 5") {
									fixed[column] = q.int(5, T.int8)
								}
								if (use === "fixed to 7") {
									fixed[column] = q.int(7, T.int8)
								}
							}
							const outer = q.region([{ source: imported, bind, constants: fixed }])
							const ran = fused(q.build(outer).dag)
							const isFixed = (use: Use) => use === "fixed to 5" || use === "fixed to 7"
							const refused =
								(isFixed(first) && second !== "existential") ||
								(isFixed(second) && first !== "existential")
							c.note(refused ? "refused" : "fused")
							assert.equal(rulesOf(ran.certificates).includes("R01.fusion"), !refused)
						})
				)
			)
	)
})

/**
 * What the imported stage holds or how it is read: a plain projection, a filter of a column, a filter of a computed
 * value, an aggregate, a region correlated with the outer region, or a stage whose column a later source reads
 * laterally.
 */
type Chain =
	| "a projection"
	| "a plain filter"
	| "a computed filter"
	| "an aggregate boundary"
	| "a correlated inner region"
	| "a stage read laterally"

/** The outer region matching the imported stage beside the accounts, under the chain drawn. */
const chained = (chain: Chain): RelDag => {
	const q = new Q()
	if (chain === "a correlated inner region") {
		const outerId = q.b.reserve()
		const inner = q.regionWith(
			[
				{
					source: q.base(Posting, conservativeMeta),
					bind: { id: "id", account: "account" },
					constants: {}
				}
			],
			{
				...plainRegion,
				correlated: [{ name: "account", type: T.uuid, expr: outerCol(q, outerId, "acct", T.uuid) }]
			}
		)
		const imported = q.project(inner, [["id", "id"]], conservativeMeta)
		const outer = q.regionWith(
			[
				{ source: q.base(Account, conservativeMeta), bind: { id: "acct" }, constants: {} },
				{ source: imported, bind: { id: "task" }, constants: {} }
			],
			{ ...plainRegion, id: { kind: "reserved", id: outerId } }
		)
		return q.build(q.project(outer, [["task", "task"]], conservativeMeta)).dag
	}
	if (chain === "a stage read laterally") {
		const imported = q.project(
			q.region([
				{
					source: q.base(Account, conservativeMeta),
					bind: { id: "id", name: "name" },
					constants: {}
				}
			]),
			[
				["id", "id"],
				["name", "name"]
			],
			conservativeMeta
		)
		const later = q.regionWith(
			[
				{
					source: q.base(Account, conservativeMeta),
					bind: { id: "other", name: "same" },
					constants: {}
				}
			],
			{
				...plainRegion,
				correlated: [{ name: "same", type: T.text, expr: outerCol(q, imported.id, "name", T.text) }]
			}
		)
		const outer = q.region([
			{ source: imported, bind: { id: "acct" }, constants: {} },
			{ source: later, bind: { other: "other" }, constants: {} }
		])
		return q.build(
			q.project(
				outer,
				[
					["acct", "acct"],
					["other", "other"]
				],
				conservativeMeta
			)
		).dag
	}
	const inner = postings(q)
	const imported =
		chain === "an aggregate boundary"
			? q.group(
					inner,
					["id", "account", "amount"],
					["account"],
					[{ name: "total", fn: "sum", op: "sum(bigint)", args: ["amount"], type: T.numeric }],
					conservativeMeta
				)
			: q.project(
					chain === "a projection"
						? inner
						: q.filter(
								inner,
								chain === "a plain filter"
									? q.op("int8gt", [q.col(inner, "amount"), q.int(5, T.int8)], T.bool)
									: q.op(
											"int8gt",
											[
												q.op("int8pl", [q.col(inner, "amount"), q.int(1, T.int8)], T.int8),
												q.int(5, T.int8)
											],
											T.bool
										)
							),
					[["account", "account"]],
					conservativeMeta
				)
	const outer = q.region([
		{ source: imported, bind: { account: "acct" }, constants: {} },
		{ source: q.base(Account, conservativeMeta), bind: { id: "acct", name: "name" }, constants: {} }
	])
	return q.build(q.project(outer, [["name", "name"]], conservativeMeta)).dag
}

describe("boundaries and refusals", () => {
	it.effect(
		"fuses a chain of projections and filters, and nothing that would change scope",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/rewrite/fuse-boundaries",
						literal: Formatter.format,
						generator: element<Chain>([
							"a projection",
							"a plain filter",
							"a computed filter",
							"an aggregate boundary",
							"a correlated inner region",
							"a stage read laterally"
						]),
						limit: 6,
						coverage: requiredInSpace<Chain>([
							"a projection",
							"a plain filter",
							"a computed filter",
							"an aggregate boundary",
							"a correlated inner region",
							"a stage read laterally"
						]),
						caseHang
					},
					(chain, c) =>
						Effect.sync(() => {
							c.note(chain)
							const ran = fused(chained(chain))
							assert.equal(
								rulesOf(ran.certificates).includes("R01.fusion"),
								chain === "a projection" ||
									chain === "a plain filter" ||
									chain === "a computed filter"
							)
						})
				)
			)
	)
})
