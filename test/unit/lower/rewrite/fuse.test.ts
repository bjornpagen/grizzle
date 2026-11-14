/**
 * R01 fusion (lower/optimize/fuse): an imported stage written as a region under filters and renames is inlined into the
 * region that matches it, preserving the complete bound tuple and every aggregate boundary, with the (account, amount)
 * versus (id, account, amount) counterexample held to the reference; a boundary, a correlated stage, two constants on
 * one inner variable, or a constant reading a column on a variable the stage's filter reads is never fused. Every
 * fusion delivers what its original does, by the reference evaluator, on every database of the candidate facts, alone
 * and composed with the rewrite phases, and lowers conservatively.
 *
 * Oracle: the rule's statement as a checker over exhaustive planted spaces (a specification), the reference evaluator's
 * delivery (a second implementation); the boundary search is the guard population's (rewrite/guarded.ts).
 *
 * Features: each bound tuple under each reader; fused and refused fixed columns; the guard shapes, a group that kept its
 * bound tuple and a scoped stage kept.
 *
 * Plants, each failing its search: a fused region delivering the variables its import hid (fuse-hidden-delivered); one
 * inner variable two fixed columns carry fused (fuse-fixed-twice); a correlated stage fused (fuse-correlated).
 */
import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { element } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
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
import { Account, Posting, Q, T, uuidOf } from "#test/unit/lower/conservative/fixtures.ts"

import { caseHang } from "#test/support/limits.ts"
import { guardSearch, scopedStay } from "#test/unit/lower/rewrite/guarded.ts"
import {
	passContext,
	deliversAlikeOn,
	factSubsets,
	ledgerCatalog,
	lowersConservatively,
	nodesOf,
	queryOf,
	type Ran,
	rulesOf,
	runPasses
} from "#test/unit/lower/rewrite/support.ts"

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
						box: "an import of (account, amount) or (id, account, amount), read by the query or by a fold",
						oracle: {
							kind: "specification",
							name: "R01 fuses the stage and the fold keeps its bound tuple; the reference's delivery on every database"
						},
						suite: "unit/lower/rewrite/fuse-bound-tuple",
						literal: Formatter.format,
						generator: (source) =>
							[
								source.draw(element<Bound>(["account, amount", "id, account, amount"])),
								source.draw(element<Reader>(["a fold", "the query"]))
							] as const,
						coverage: requiredInSpace<`${Bound} read by ${Reader}`>([
							"account, amount read by a fold",
							"account, amount read by the query",
							"id, account, amount read by a fold",
							"id, account, amount read by the query"
						]),
						caseHang,
						concurrency: 1
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
 * leave it existential, bind it to a variable of its own, fix it to 5 or to 7, or fix it to another posting's amount,
 * a constant that reads a column of an earlier occurrence's source.
 */
type Use = "existential" | "bound" | "fixed to 5" | "fixed to 7" | "fixed to a read"

const uses = element<Use>(["existential", "bound", "fixed to 5", "fixed to 7", "fixed to a read"])

/** Whether the imported stage filters the amount its two columns carry, so a predicate reads the inner variable. */
type Stage = "filtered" | "unfiltered"

describe("fixed columns in R01 fusion", () => {
	it.effect(
		"two columns carrying one inner variable fuse unless one is fixed and the other fixed or bound, or a read fixes a filtered one",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "every use of each of two columns carrying one inner variable, over a filtered or an unfiltered stage",
						oracle: {
							kind: "specification",
							name: "fused unless one column is fixed and the other fixed or bound, or a read fixes a filtered one"
						},
						suite: "unit/lower/rewrite/fuse-fixed-columns",
						literal: Formatter.format,
						generator: (source) =>
							[
								source.draw(uses),
								source.draw(uses),
								source.draw(element<Stage>(["filtered", "unfiltered"]))
							] as const,
						coverage: requiredInSpace<"fused" | "refused">(["fused", "refused"]),
						caseHang,
						concurrency: 1
					},
					([first, second, stage], c) =>
						Effect.sync(() => {
							const q = new Q()
							const inner = postings(q)
							const imported = q.project(
								stage === "filtered"
									? q.filter(
											inner,
											q.op("int8gt", [q.col(inner, "amount"), q.int(6, T.int8)], T.bool)
										)
									: inner,
								[
									["id", "id"],
									["a1", "amount"],
									["a2", "amount"]
								],
								conservativeMeta
							)
							const other = q.base(Posting, conservativeMeta)
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
								if (use === "fixed to a read") {
									fixed[column] = q.col(other, "amount")
								}
							}
							const outer = q.region([
								{ source: other, bind: { id: "other" }, constants: {} },
								{ source: imported, bind, constants: fixed }
							])
							const ran = fused(q.build(outer).dag)
							const isFixed = (use: Use) =>
								use === "fixed to 5" || use === "fixed to 7" || use === "fixed to a read"
							const refused =
								(isFixed(first) && second !== "existential") ||
								(isFixed(second) && first !== "existential") ||
								(stage === "filtered" &&
									(first === "fixed to a read" || second === "fixed to a read"))
							c.note(refused ? "refused" : "fused")
							assert.equal(rulesOf(ran.certificates).includes("R01.fusion"), !refused)
						})
				)
			)
	)
})

describe("boundaries and refusals", () => {
	it.effect(
		"fuses no stage across an aggregate boundary, and none an expression correlates or another occurrence reads laterally",
		(ctx) =>
			searched(
				ctx,
				guardSearch<"a group kept its bound tuple" | "a scoped stage kept">({
					suite: "unit/lower/rewrite/fuse-boundaries",
					passes: [fusePass],
					evidence: "snapshot",
					runs: 150,
					situations: [
						"R01.fusion",
						"a region over a group",
						"an occurrence over a correlated source",
						"an occurrence whose source another occurrence reads laterally",
						"a group kept its bound tuple",
						"a scoped stage kept"
					],
					holds: (_q, input, ran, c) => {
						const after = nodesByLabel(ran.query.dag)
						for (const group of nodesOf(input.dag, "Group")) {
							const kept = after.get(group.id)
							assert.deepEqual(
								kept?.kind === "Group" ? kept.bound.columns : [],
								group.bound.columns,
								`the group ${group.id}`
							)
							c.note("a group kept its bound tuple")
						}
						if (scopedStay(input.dag, ran.query.dag) > 0) {
							c.note("a scoped stage kept")
						}
					}
				})
			)
	)
})
