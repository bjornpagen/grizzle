import { describe, it } from "@effect/vitest"
import { assertNone } from "@effect/vitest/utils"
import { exhaust } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { constant, element, type Gen, oneOf } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option } from "effect"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import { nodesByLabel } from "#compiler/ir/dag.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { Pass } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { conservativeMeta, type RelDag } from "#compiler/ir/rel.ts"
import { relationalRewrites } from "#compiler/lower/optimize/demand/phases.ts"
import { existencePass } from "#compiler/lower/optimize/existence/index.ts"
import { prunePass } from "#compiler/lower/optimize/prune/index.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { keyConstraintName } from "#test/support/evidence.ts"
import {
	Account as AccountRelation,
	type OccurrenceSpec,
	Posting,
	plainRegion,
	Q,
	type RelationSpec,
	T,
	uuidOf
} from "#test/unit/lower/conservative/fixtures.ts"

import {
	passContext,
	deliversAlikeOn,
	factSubsets,
	ledgerCatalog,
	lowersConservatively,
	nodesOf,
	outerCol,
	queryOf,
	type Ran,
	rulesOf,
	runPasses
} from "#test/unit/lower/rewrite/support.ts"

/**
 * R02: express existence as existence. An occurrence whose every variable another
 * occurrence binds contributes only existence and becomes a semi-join's right side; a match binding a witness of its
 * own is never touched ("a match binding a witness ID is different"), and a fold's bound tuple is unchanged.
 * A set comparison becomes a semi- or anti-join only over a physically unique left input.
 */

const u = (n: number): TypedLiteral => ({ kind: "uuid", value: uuidOf(n) })
const i8 = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })
const text = (s: string): TypedLiteral => ({ kind: "text", value: s })

/**
 * Every database of these posting and account facts: two postings of account 10, one of account 11, one of account
 * 12, which no account holds, and two accounts named apart.
 */
const databases = factSubsets({
	Posting: [
		[u(1), u(10), i8(5)],
		[u(2), u(10), i8(5)],
		[u(3), u(11), i8(7)],
		[u(4), u(12), i8(7)]
	],
	Account: [
		[u(10), text("a")],
		[u(11), text("b")]
	]
})

/**
 * The Account occurrence of a posting's match: existence only (it binds its id, which the posting binds too), the same
 * with its name fixed, or binding its name, which the query delivers: a witness of its own.
 */
type Account = "existence only" | "with a constant" | "delivers its witness"
/**
 * Who reads the region: a projection onto the posting's id, with the region's heading every bound variable or the id
 * alone (the shared account outside it), the query delivering that region as it is, or a fold over the complete bound
 * tuple.
 */
type Reader =
	| "projection"
	| "projection, shared variable outside the heading"
	| "root, shared variable outside the heading"
	| "fold"

/**
 * A posting matched with the account it names, under the Account occurrence and the reader drawn; the group node when
 * the reader folds.
 */
const matched = (account: Account, reader: Reader) => {
	const q = new Q()
	const occurrences: ReadonlyArray<OccurrenceSpec> = [
		{
			source: q.base(Posting, conservativeMeta),
			bind: { id: "id", account: "acct", amount: "amount" },
			constants: {}
		},
		account === "with a constant"
			? {
					source: q.base(AccountRelation, conservativeMeta),
					bind: { id: "acct" },
					constants: { name: q.lit(text("a"), T.text) }
				}
			: {
					source: q.base(AccountRelation, conservativeMeta),
					bind: account === "delivers its witness" ? { id: "acct", name: "name" } : { id: "acct" },
					constants: {}
				}
	]
	if (reader === "fold") {
		const region = q.region(occurrences)
		const group = q.group(
			region,
			["id", "acct", "amount"],
			["acct"],
			[{ name: "total", fn: "sum", op: "sum(bigint)", args: ["amount"], type: T.numeric }],
			conservativeMeta
		)
		return {
			dag: q.build(q.project(group, [["total", "total"]], conservativeMeta)).dag,
			group: [group]
		}
	}
	if (reader === "root, shared variable outside the heading") {
		return {
			dag: q.build(
				q.regionWith(occurrences, { ...plainRegion, heading: { kind: "named", names: ["id"] } })
			).dag,
			group: []
		}
	}
	const region =
		reader === "projection"
			? q.region(occurrences)
			: q.regionWith(occurrences, { ...plainRegion, heading: { kind: "named", names: ["id"] } })
	const delivered: ReadonlyArray<readonly [string, string]> =
		account === "delivers its witness"
			? [
					["id", "id"],
					["name", "name"]
				]
			: [["id", "id"]]
	return { dag: q.build(q.project(region, delivered, conservativeMeta)).dag, group: [] }
}

const rewritten = (dag: RelDag, passes: ReadonlyArray<Pass<LogicalQuery, LogicalQuery>>): Ran => {
	const query = queryOf(dag, [])
	const ran = succeeded(
		runPasses(query, passes, passContext({ catalog: ledgerCatalog, evidence: "snapshot" }))
	)
	deliversAlikeOn(databases, [Posting, AccountRelation], [], query, ran.query)
	lowersConservatively(ran.query)
	return ran
}

const shapes: Gen<readonly [Account, Reader]> = oneOf<readonly [Account, Reader]>([
	(source) =>
		[
			source.draw(element<Account>(["existence only", "with a constant"])),
			source.draw(
				element<Reader>([
					"projection",
					"projection, shared variable outside the heading",
					"root, shared variable outside the heading",
					"fold"
				])
			)
		] as const,
	constant<readonly [Account, Reader]>(["delivers its witness", "projection"])
])

describe("an existence-only match becomes a semi-join", () => {
	it.effect(
		"an occurrence binding nothing of its own becomes a semi-join, its constants with it, the reader's heading and bound tuple kept",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/rewrite/existence-semi-join",
						literal: Formatter.format,
						generator: shapes,
						limit: 9,
						features: features<`${Account} under a ${Reader}`>([
							"existence only under a projection",
							"existence only under a projection, shared variable outside the heading",
							"existence only under a root, shared variable outside the heading",
							"existence only under a fold",
							"with a constant under a projection",
							"with a constant under a projection, shared variable outside the heading",
							"with a constant under a root, shared variable outside the heading",
							"with a constant under a fold",
							"delivers its witness under a projection"
						]),
						caseHang: Duration.minutes(2)
					},
					([account, reader], c) =>
						Effect.sync(() => {
							c.note(`${account} under a ${reader}`)
							const { dag, group } = matched(account, reader)
							const ran = rewritten(dag, [prunePass, existencePass])
							rewritten(dag, [relationalRewrites])
							assert.equal(
								rulesOf(ran.certificates).includes("R02.semiJoin"),
								account !== "delivers its witness"
							)
							for (const g of group) {
								const after = nodesByLabel(ran.query.dag).get(g.id)
								assert.deepEqual(after?.kind === "Group" ? after.bound : [], [
									"id",
									"acct",
									"amount"
								])
							}
						})
				)
			)
	)
})

/**
 * Where the left input's rows come from: the accounts' ids, unique by Account's key, or the postings' accounts, which
 * repeat.
 */
type Left = "account ids" | "posting accounts"
type Evidence = "snapshot" | "transaction"

const accountKey = keyConstraintName(ledgerCatalog, "Account", ["id"], "primary")

describe("set comparisons need a physically unique left input", () => {
	it.effect(
		"a keyed left input admits the rewrite, its key's premises and context in the certificate",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/rewrite/existence-set-comparison",
						literal: Formatter.format,
						generator: (source) => ({
							op: source.draw(element<"Intersect" | "Difference">(["Intersect", "Difference"])),
							left: source.draw(element<Left>(["account ids", "posting accounts"])),
							evidence: source.draw(element<Evidence>(["snapshot", "transaction"]))
						}),
						limit: 8,
						features: features<`${"Intersect" | "Difference"} ${"rewritten" | "kept"}`>([
							"Intersect rewritten",
							"Intersect kept",
							"Difference rewritten",
							"Difference kept"
						]),
						caseHang: Duration.minutes(2)
					},
					({ op, left, evidence }, c) =>
						Effect.sync(() => {
							const q = new Q()
							const ids = (relation: RelationSpec, column: string) =>
								q.project(
									q.region([
										{
											source: q.base(relation, conservativeMeta),
											bind: { [column]: "id" },
											constants: {}
										}
									]),
									[["id", "id"]],
									conservativeMeta
								)
							const accounts = ids(AccountRelation, "id")
							const postings = ids(Posting, "account")
							const dag = q.build(
								left === "account ids"
									? q.setOp(op, accounts, postings)
									: q.setOp(op, postings, accounts)
							).dag
							const query = queryOf(dag, [])
							const ran = succeeded(
								runPasses(query, [existencePass], passContext({ catalog: ledgerCatalog, evidence }))
							)
							deliversAlikeOn(databases, [Posting, AccountRelation], [], query, ran.query)
							const rule: CertificateRule = op === "Intersect" ? "R02.semiJoin" : "R02.antiJoin"
							const unique = left === "account ids"
							c.note(`${op} ${unique ? "rewritten" : "kept"}`)
							const cert = Arr.findFirst(ran.certificates, (x) => x.rule === rule)
							if (!unique) {
								assertNone(cert)
								return
							}
							const certified = Option.getOrThrowWith(
								cert,
								() => new Error("the set comparison's certificate")
							)
							assert.deepEqual(
								Arr.flatMap(certified.premises, (p) =>
									p.kind === "constraint" ? [p.constraint] : []
								),
								[accountKey]
							)
							assert.equal(certified.context, "immediate")
						})
				)
			)
	)
})

/**
 * An occurrence whose source reads another scope: a region correlated with the outer region's label, or the Account
 * scan another occurrence's source reads laterally.
 */
type Scope = "a correlated source" | "a source read laterally"

describe("scope", () => {
	it.effect(
		"an occurrence over a correlated source, or whose source an expression reads laterally, stays in its region",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/rewrite/existence-scope",
						literal: Formatter.format,
						generator: element<Scope>(["a correlated source", "a source read laterally"]),
						limit: 2,
						features: features<Scope>(["a correlated source", "a source read laterally"]),
						caseHang: Duration.minutes(2)
					},
					(scope, c) =>
						Effect.sync(() => {
							c.note(scope)
							const q = new Q()
							if (scope === "a correlated source") {
								const outerId = q.b.reserve()
								const correlated = q.regionWith(
									[
										{
											source: q.base(AccountRelation, conservativeMeta),
											bind: { id: "acct", name: "name" },
											constants: {}
										}
									],
									{
										...plainRegion,
										correlated: [
											{ name: "name", type: T.text, expr: outerCol(q, outerId, "label", T.text) }
										],
										heading: { kind: "named", names: ["acct"] }
									}
								)
								const outerRegion = q.regionWith(
									[
										{
											source: q.base(AccountRelation, conservativeMeta),
											bind: { id: "other", name: "label" },
											constants: {}
										},
										{
											source: q.base(Posting, conservativeMeta),
											bind: { id: "id", account: "acct" },
											constants: {}
										},
										{ source: correlated, bind: { acct: "acct" }, constants: {} }
									],
									{ ...plainRegion, id: { kind: "reserved", id: outerId } }
								)
								const ran = rewritten(
									q.build(q.project(outerRegion, [["id", "id"]], conservativeMeta)).dag,
									[existencePass]
								)
								const outer = Arr.findFirst(
									nodesOf(ran.query.dag, "MatchRegion"),
									(r) => r.id === outerId
								)
								assert.equal(
									Option.exists(outer, (r) =>
										Arr.some(r.occurrences, (o) => o.source.id === correlated.id)
									),
									true
								)
								return
							}
							const accounts = q.base(AccountRelation, conservativeMeta)
							const reader = q.regionWith(
								[
									{
										source: q.base(Posting, conservativeMeta),
										bind: { id: "pid", account: "acct" },
										constants: {}
									}
								],
								{
									...plainRegion,
									correlated: [
										{ name: "acct", type: T.uuid, expr: outerCol(q, accounts.id, "id", T.uuid) }
									]
								}
							)
							const region = q.region([
								{
									source: q.base(Posting, conservativeMeta),
									bind: { id: "id", account: "acct" },
									constants: {}
								},
								{ source: accounts, bind: { id: "acct" }, constants: {} },
								{ source: reader, bind: { pid: "pid" }, constants: {} }
							])
							const ran = rewritten(
								q.build(
									q.project(
										region,
										[
											["id", "id"],
											["pid", "pid"]
										],
										conservativeMeta
									)
								).dag,
								[existencePass]
							)
							const r = nodesByLabel(ran.query.dag).get(region.id)
							assert.equal(
								r?.kind === "MatchRegion"
									? Arr.some(r.occurrences, (o) => o.source.id === accounts.id)
									: false,
								true
							)
						})
				)
			)
	)
})
