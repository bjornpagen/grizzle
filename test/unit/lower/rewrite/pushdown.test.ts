import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Effect, Formatter } from "effect"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import type { ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import { conservativeMeta, type RelDag, type RelNode } from "#compiler/ir/rel.ts"
import { pushdownPass } from "#compiler/lower/optimize/pushdown/index.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import {
	Account,
	asc,
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
	outerCol,
	queryOf,
	rulesOf,
	runPasses
} from "#test/unit/lower/rewrite/support.ts"

/**
 * Legal predicate movement: a group-key restriction moves below the aggregate and an
 * aggregate-result restriction does not; nothing moves below a take; a predicate that can fail moves only where it is
 * evaluated on the same rows; union arms are filtered each on its own columns.
 */

const u = (n: number): TypedLiteral => ({ kind: "uuid", value: uuidOf(n) })
const i8 = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })
const text = (s: string): TypedLiteral => ({ kind: "text", value: s })

/**
 * Every database of these posting and account facts: account 10's postings total 12, above the threshold 10, and
 * amounts sit on either side of 6; account 12 holds no posting.
 */
const databases = factSubsets({
	Posting: [
		[u(1), u(10), i8(5)],
		[u(2), u(10), i8(7)],
		[u(3), u(11), i8(7)]
	],
	Account: [
		[u(10), text("a")],
		[u(11), text("b")]
	]
})

const postings = (q: Q) =>
	q.region([
		{
			source: q.base(Posting, conservativeMeta),
			bind: { id: "id", account: "account", amount: "amount" },
			constants: {}
		}
	])

const totalsOf = (q: Q, region: RelNode) =>
	q.group(
		region,
		["id", "account", "amount"],
		["account"],
		[{ name: "total", fn: "sum", op: "sum(bigint)", args: ["amount"], type: T.numeric }],
		conservativeMeta
	)

/** amount > 6. */
const onAmount = (q: Q, node: RelNode): ScalarExpr =>
	q.op("int8gt", [q.col(node, "amount"), q.int(6, T.int8)], T.bool)

/** total > 10. */
const onTotal = (q: Q, node: RelNode, column: string): ScalarExpr =>
	q.op("numeric_gt", [q.col(node, column), q.decimal("10", T.numeric)], T.bool)

/**
 * The node a filter sits on: a projection, a group (filtered on its key or on its aggregate), a union, a take, a
 * semi-join's left side, or a region whose occurrence's source is a group, plain or correlated with another source.
 */
type Site =
	| "projection"
	| "group key"
	| "group aggregate"
	| "union"
	| "take"
	| "semi-join"
	| "group source"
	| "correlated group source"

/** The filter over its site, and the query delivering it. */
const filtered = (site: Site): RelDag => {
	const q = new Q()
	const deliver = (f: RelNode, column: string) =>
		q.build(q.project(f, [[column, column]], conservativeMeta)).dag
	switch (site) {
		case "projection": {
			const p = q.project(
				postings(q),
				[
					["id", "id"],
					["amount", "amount"]
				],
				conservativeMeta
			)
			return deliver(q.filter(p, onAmount(q, p)), "id")
		}
		case "group key": {
			const g = totalsOf(q, postings(q))
			return deliver(
				q.filter(g, q.op("uuid_eq", [q.col(g, "account"), q.lit(u(10), T.uuid)], T.bool)),
				"total"
			)
		}
		case "group aggregate": {
			const g = totalsOf(q, postings(q))
			return deliver(q.filter(g, onTotal(q, g, "total")), "account")
		}
		case "union": {
			const arm = (filterAmount: number) => {
				const p = postings(q)
				return q.project(
					q.filter(p, q.op("int8ge", [q.col(p, "amount"), q.int(filterAmount, T.int8)], T.bool)),
					[
						["id", "id"],
						["amount", "amount"]
					],
					conservativeMeta
				)
			}
			const u2 = q.union([arm(5), arm(7)], [])
			return deliver(q.filter(u2, onAmount(q, u2)), "id")
		}
		case "take": {
			const take = q.take(
				postings(q),
				asc("id", "account", "amount"),
				{ kind: "literal", k: 1n },
				[],
				conservativeMeta
			)
			return deliver(q.filter(take, onAmount(q, take)), "id")
		}
		case "semi-join": {
			const right = q.region([
				{ source: q.base(Account, conservativeMeta), bind: { id: "account" }, constants: {} }
			])
			const semi = q.semi(postings(q), right, [["account", "account"]])
			return deliver(q.filter(semi, onAmount(q, semi)), "id")
		}
		case "group source":
		case "correlated group source": {
			const accounts = q.base(Account, conservativeMeta)
			const inner =
				site === "group source"
					? postings(q)
					: q.regionWith(
							[
								{
									source: q.base(Posting, conservativeMeta),
									bind: { id: "id", account: "account", amount: "amount" },
									constants: {}
								}
							],
							{
								...plainRegion,
								correlated: [
									{ name: "account", type: T.uuid, expr: outerCol(q, accounts.id, "id", T.uuid) }
								]
							}
						)
			const region = q.region([
				{ source: accounts, bind: { id: "acct", name: "name" }, constants: {} },
				{ source: totalsOf(q, inner), bind: { account: "acct", total: "total" }, constants: {} }
			])
			return deliver(q.filter(region, onTotal(q, region, "total")), "name")
		}
	}
}

/**
 * The documented rule as the oracle: whether the rule that would move the filter off its site fires. A filter moves
 * through a projection, a union and a group key, below a semi-join's left side and onto a region's source, since no
 * predicate raises on the rows it meets there (scalar/compute/registry.ts Totality); a restriction on an aggregate
 * result and a correlated source keep it where it is, and below a take nothing moves at all.
 */
type Movement =
	| { readonly kind: "moves" | "stays"; readonly rule: CertificateRule }
	| { readonly kind: "nothing moves" }

const movementOf = (site: Site): Movement => {
	switch (site) {
		case "projection":
			return { kind: "moves", rule: "pushdown.project" }
		case "group key":
			return { kind: "moves", rule: "pushdown.group" }
		case "union":
			return { kind: "moves", rule: "pushdown.union" }
		case "semi-join":
			return { kind: "moves", rule: "pushdown.left" }
		case "group source":
			return { kind: "moves", rule: "pushdown.source" }
		case "group aggregate":
			return { kind: "stays", rule: "pushdown.group" }
		case "correlated group source":
			return { kind: "stays", rule: "pushdown.source" }
		case "take":
			return { kind: "nothing moves" }
	}
}

const sites = element<Site>([
	"projection",
	"group key",
	"group aggregate",
	"union",
	"take",
	"semi-join",
	"group source",
	"correlated group source"
])

describe("legal predicate movement", () => {
	it.effect("moves a filter exactly where the move keeps its set", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/lower/rewrite/pushdown-sites",
					literal: Formatter.format,
					generator: sites,
					limit: 15,
					coverage: requiredInSpace<`${Site} ${"moved" | "stays"}`>([
						"projection moved",
						"group key moved",
						"group aggregate stays",
						"union moved",
						"take stays",
						"semi-join moved",
						"group source moved",
						"correlated group source stays"
					]),
					caseHang
				},
				(site, c) =>
					Effect.sync(() => {
						const dag = filtered(site)
						const query = queryOf(dag, [])
						const ran = succeeded(
							runPasses(
								query,
								[pushdownPass],
								passContext({ catalog: ledgerCatalog, evidence: "snapshot" })
							)
						)
						const movement = movementOf(site)
						c.note(`${site} ${movement.kind === "moves" ? "moved" : "stays"}`)
						if (movement.kind === "nothing moves") {
							assert.deepEqual(ran.certificates, [])
						} else {
							assert.equal(
								rulesOf(ran.certificates).includes(movement.rule),
								movement.kind === "moves"
							)
						}
						deliversAlikeOn(databases, [Posting, Account], [], query, ran.query)
					})
			)
		)
	)
})
