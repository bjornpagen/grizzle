/** What the properties of late-fetch.test.ts read: its spaces, models and helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { conservativeMeta, type RelDag } from "#compiler/ir/rel.ts"
import { lateFetchPass } from "#compiler/lower/optimize/late-fetch/index.ts"
import { succeeded } from "#test/support/assert.ts"
import { keyConstraintName } from "#test/support/evidence.ts"
import {
	Account,
	asc,
	keyed,
	plainRegion,
	Posting,
	Q,
	T,
	uuidOf
} from "#test/support/unit/lower/conservative/fixtures.ts"
import {
	deliversAlikeOn,
	factSubsets,
	ledgerCatalog,
	lowersConservatively,
	outerCol,
	passContext,
	queryOf,
	type Ran,
	runPasses
} from "#test/support/unit/lower/rewrite/support.ts"

/** A uuid literal of the ledger fixture's n-th id (conservative/fixtures.ts uuidOf). */
const u = (n: number): TypedLiteral => ({ kind: "uuid", value: uuidOf(n) })

/** A bigint literal. */
const i8 = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })

/** A text literal. */
const text = (s: string): TypedLiteral => ({ kind: "text", value: s })

/**
 * Every database of these account and posting facts: two accounts share a name, so a name alone determines no account,
 * and postings name two of them.
 */
const databases = factSubsets({
	Account: [
		[u(3), text("same")],
		[u(1), text("same")],
		[u(2), text("other")]
	],
	Posting: [
		[u(5), u(1), i8(5)],
		[u(6), u(3), i8(7)]
	]
})

/** The name of Account's primary key in the ledger's catalog. */
export const accountKey = keyConstraintName(ledgerCatalog, "Account", ["id"])

/**
 * The stage a take bounds: accounts' (id, name), carrying Account's key beside its wide name, or postings matched with
 * their account's name, (pid, name), which carries Account's name without its key.
 */
type Stage = "carries Account's key" | "carries no Account key"

/** The take's order: by the stage's key alone, or reading the payload first. */
type Order = "by the key" | "reading the payload"

/**
 * Who reads the take: the query, or a region joining it to every account, one whose source reads nothing laterally,
 * the take's name, or its stage's name, the region scanning the stage at the taken key too, so the stage is in the
 * source's scope.
 */
type Reader =
	| "the query"
	| "a join"
	| "a join reading the take laterally"
	| "a join reading the stage laterally"

/** The evidence context a case runs the pass in. */
export type Evidence = "snapshot" | "transaction"

/** A case of the box: the stage, its order, its reader, the bound and the evidence context. */
interface Shape {
	readonly stage: Stage
	readonly order: Order
	readonly reader: Reader
	readonly k: 1 | 2
	readonly evidence: Evidence
}

/** The take(k) over the stage, under the order, read by the reader. */
export const bounded = (shape: Shape): { readonly dag: RelDag } => {
	const q = new Q()
	const keyColumn = shape.stage === "carries Account's key" ? "id" : "pid"
	const region =
		shape.stage === "carries Account's key"
			? q.region([
					{
						source: q.base(Account, conservativeMeta),
						bind: { id: "id", name: "name" },
						constants: {}
					}
				])
			: q.region([
					{
						source: q.base(Posting, conservativeMeta),
						bind: { id: "pid", account: "acct" },
						constants: {}
					},
					{
						source: q.base(Account, conservativeMeta),
						bind: { id: "acct", name: "name" },
						constants: {}
					}
				])
	const stage = q.project(
		region,
		[
			[keyColumn, keyColumn],
			["name", "name"]
		],
		keyed([keyColumn], "many")
	)
	const take = q.take(
		stage,
		shape.order === "by the key" ? asc(keyColumn) : asc("name", keyColumn),
		{ kind: "literal", k: BigInt(shape.k) },
		[],
		conservativeMeta
	)
	if (shape.reader === "the query") {
		return { dag: q.build(take).dag }
	}
	const later =
		shape.reader === "a join"
			? q.region([
					{ source: q.base(Account, conservativeMeta), bind: { id: "other" }, constants: {} }
				])
			: q.regionWith(
					[
						{
							source: q.base(Account, conservativeMeta),
							bind: { id: "other", name: "same" },
							constants: {}
						}
					],
					{
						...plainRegion,
						correlated: [
							{
								name: "same",
								type: T.text,
								expr: outerCol(
									q,
									shape.reader === "a join reading the take laterally" ? take.id : stage.id,
									"name",
									T.text
								)
							}
						]
					}
				)
	const outer = q.region([
		{ source: take, bind: { [keyColumn]: "key", name: "name" }, constants: {} },
		...(shape.reader === "a join reading the stage laterally"
			? [{ source: stage, bind: { [keyColumn]: "key" }, constants: {} }]
			: []),
		{ source: later, bind: { other: "other" }, constants: {} }
	])
	return {
		dag: q.build(
			q.project(
				outer,
				[
					["key", "key"],
					["name", "name"],
					["other", "other"]
				],
				conservativeMeta
			)
		).dag
	}
}

/** Runs late fetch over the DAG in the context, holding it to every database's delivery. */
export const fetchedUnder = (dag: RelDag, evidence: Evidence): Ran => {
	const query = queryOf(dag, [])
	const ran = succeeded(
		runPasses(query, [lateFetchPass], passContext({ catalog: ledgerCatalog, evidence }))
	)
	deliversAlikeOn(databases, [Account, Posting], [], query, ran.query)
	lowersConservatively(ran.query, emptyCodebook)
	return ran
}

/** Every case of the box. */
export const shapes: Gen<Shape> = (source) => ({
	stage: source.draw(element<Stage>(["carries Account's key", "carries no Account key"])),
	order: source.draw(element<Order>(["by the key", "reading the payload"])),
	reader: source.draw(
		element<Reader>([
			"the query",
			"a join",
			"a join reading the take laterally",
			"a join reading the stage laterally"
		])
	),
	k: source.draw(element<1 | 2>([1, 2])),
	evidence: source.draw(element<Evidence>(["snapshot", "transaction"]))
})

/** What the takes reach: the fetch on each evidence, and each guard holding it back. */
export type LateFetchFeature =
	| `fetched on ${Evidence} evidence`
	| "held back: the order reads the payload"
	| "held back: no key of the payload's relation"
	| "held back: a lateral reader"
