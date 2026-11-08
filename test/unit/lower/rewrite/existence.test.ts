import { describe, it } from "@effect/vitest"
import { assertNone } from "@effect/vitest/utils"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { nodesByLabel } from "#compiler/ir/dag.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { Pass } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { conservativeMeta, type RelDag } from "#compiler/ir/rel.ts"
import { relationalRewrites } from "#compiler/lower/optimize/demand/phases.ts"
import { existencePass } from "#compiler/lower/optimize/existence/index.ts"
import { prunePass } from "#compiler/lower/optimize/prune/index.ts"
import { assert, contains, succeeded } from "#test/support/assert.ts"
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

import { caseHang } from "#test/support/limits.ts"
import { guardSearch, scopedStay } from "#test/unit/lower/rewrite/guarded.ts"
import {
	passContext,
	deliversAlikeOn,
	factSubsets,
	ledgerCatalog,
	lowersConservatively,
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
 * The Account occurrence of a posting's match: existence only (it binds its id, which the posting binds too), or the
 * same with its name fixed. One that binds a witness of its own, which the query delivers, is never touched: a semi-join's
 * right side delivers nothing, so the generated pass-alone search (generated.test.ts) would see the witness go.
 */
type Account = "existence only" | "with a constant"
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
 * The Posting occurrence's source: the stored relation, or a rule of its own projecting Posting through variables named
 * as the outer region's are, whose column references name the outer region's variables without reading them.
 */
type PostingSource = "a scan" | "its own rule"

/**
 * A posting matched with the account it names, under the Account occurrence, the reader and the posting's source
 * drawn; the group node when the reader folds.
 */
const matched = (account: Account, reader: Reader, posting: PostingSource) => {
	const q = new Q()
	const postingVariables = { id: "id", account: "acct", amount: "amount" }
	const postings =
		posting === "a scan"
			? q.base(Posting, conservativeMeta)
			: q.project(
					q.region([
						{ source: q.base(Posting, conservativeMeta), bind: postingVariables, constants: {} }
					]),
					[
						["id", "id"],
						["account", "acct"],
						["amount", "amount"]
					],
					conservativeMeta
				)
	const occurrences: ReadonlyArray<OccurrenceSpec> = [
		{
			source: postings,
			bind: postingVariables,
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
					bind: { id: "acct" },
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
	return { dag: q.build(q.project(region, [["id", "id"]], conservativeMeta)).dag, group: [] }
}

const rewritten = (dag: RelDag, passes: ReadonlyArray<Pass<LogicalQuery, LogicalQuery>>): Ran => {
	const query = queryOf(dag, [])
	const ran = succeeded(
		runPasses(query, passes, passContext({ catalog: ledgerCatalog, evidence: "snapshot" }))
	)
	deliversAlikeOn(databases, [Posting, AccountRelation], [], query, ran.query)
	lowersConservatively(ran.query, emptyCodebook)
	return ran
}

const shapes: Gen<readonly [Account, Reader, PostingSource]> = (source) =>
	[
		source.draw(element<Account>(["existence only", "with a constant"])),
		source.draw(
			element<Reader>([
				"projection",
				"projection, shared variable outside the heading",
				"root, shared variable outside the heading",
				"fold"
			])
		),
		source.draw(element<PostingSource>(["a scan", "its own rule"]))
	] as const

describe("an existence-only match becomes a semi-join", () => {
	it.effect(
		"an occurrence binding nothing of its own becomes a semi-join, its constants with it, the reader's heading and bound tuple kept",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
						suite: "unit/lower/rewrite/existence-semi-join",
						literal: Formatter.format,
						generator: shapes,
						limit: 16,
						coverage: requiredInSpace<
							`${Account} under a ${Reader}` | `postings from ${PostingSource}`
						>([
							"postings from a scan",
							"postings from its own rule",
							"existence only under a projection",
							"existence only under a projection, shared variable outside the heading",
							"existence only under a root, shared variable outside the heading",
							"existence only under a fold",
							"with a constant under a projection",
							"with a constant under a projection, shared variable outside the heading",
							"with a constant under a root, shared variable outside the heading",
							"with a constant under a fold"
						]),
						caseHang
					},
					([account, reader, posting], c) =>
						Effect.sync(() => {
							c.note(`${account} under a ${reader}`)
							c.note(`postings from ${posting}`)
							const { dag, group } = matched(account, reader, posting)
							const ran = rewritten(dag, [prunePass, existencePass])
							rewritten(dag, [relationalRewrites])
							contains(rulesOf(ran.certificates), "R02.semiJoin")
							for (const g of group) {
								const after = nodesByLabel(ran.query.dag).get(g.id)
								assert.deepEqual(after?.kind === "Group" ? after.bound.columns : [], [
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
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
						suite: "unit/lower/rewrite/existence-set-comparison",
						literal: Formatter.format,
						generator: (source) => ({
							op: source.draw(element<"Intersect" | "Difference">(["Intersect", "Difference"])),
							left: source.draw(element<Left>(["account ids", "posting accounts"])),
							evidence: source.draw(element<Evidence>(["snapshot", "transaction"]))
						}),
						limit: 8,
						coverage: requiredInSpace<`${"Intersect" | "Difference"} ${"rewritten" | "kept"}`>([
							"Intersect rewritten",
							"Intersect kept",
							"Difference rewritten",
							"Difference kept"
						]),
						caseHang
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

describe("scope", () => {
	it.effect(
		"an occurrence over a correlated source, or whose source another occurrence reads laterally, stays in its region",
		(ctx) =>
			searched(
				ctx,
				guardSearch<"a scoped occurrence stayed in its region">({
					suite: "unit/lower/rewrite/existence-scope",
					passes: [existencePass],
					evidence: "snapshot",
					runs: 150,
					situations: [
						"an occurrence over a correlated source",
						"an occurrence whose source another occurrence reads laterally",
						"a scoped occurrence stayed in its region",
						"R02.semiJoin"
					],
					holds: (_q, input, ran, c) => {
						if (scopedStay(input.dag, ran.query.dag) > 0) {
							c.note("a scoped occurrence stayed in its region")
						}
					}
				})
			)
	)
})
