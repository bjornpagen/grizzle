/**
 * R06 (lower/optimize/late-fetch): delay expensive payload work explicitly when legal. A take over wide payload selects
 * the narrow key and order tuple first and fetches the payload through the retained key in the same statement, its
 * certificate naming the key it rests on; it is refused when the key does not determine the output ("if a query
 * projects away the base key and collapses equal payloads, limiting base keys first changes the answer"), when the
 * order reads the payload, when a reader reads the take or its stage laterally, and when the take is correlated, its
 * rows selected per outer row. Every rewritten query delivers what its original does, by the reference evaluator, and
 * lowers conservatively.
 *
 * Oracle: the rule's statement as a checker over an exhaustive planted space and over generated wide-payload cases (a
 * specification), the reference evaluator's delivery (a second implementation).
 *
 * Features: fetched on each evidence; held back by each guard; a correlated take held back.
 *
 * Plants, each failing its search: a wide column the order reads fetched late (late-fetch-ordered-payload); a
 * correlated take's payload fetched late (late-fetch-correlated).
 */
import { describe, it } from "@effect/vitest"
import { assertNone } from "@effect/vitest/utils"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { conservativeMeta, type RelDag } from "#compiler/ir/rel.ts"
import { lateFetchPass } from "#compiler/lower/optimize/late-fetch/index.ts"
import { assert, lacks, succeeded } from "#test/support/assert.ts"
import { genCatalog, keyConstraintName } from "#test/support/evidence.ts"
import {
	Account,
	asc,
	keyed,
	Posting,
	plainRegion,
	Q,
	T,
	uuidOf
} from "#test/unit/lower/conservative/fixtures.ts"

import { caseHang } from "#test/support/limits.ts"
import { schemaCodes } from "#test/support/oracle/gen/schema.ts"
import {
	agrees,
	caseQuery,
	lowerConservatively,
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
import { wideCaseGen } from "#test/unit/lower/rewrite/wide.ts"

const u = (n: number): TypedLiteral => ({ kind: "uuid", value: uuidOf(n) })
const i8 = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })
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

const accountKey = keyConstraintName(ledgerCatalog, "Account", ["id"], "primary")

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
type Evidence = "snapshot" | "transaction"

interface Shape {
	readonly stage: Stage
	readonly order: Order
	readonly reader: Reader
	readonly k: 1 | 2
	readonly evidence: Evidence
}

/** The take(k) over the stage, under the order, read by the reader. */
const bounded = (shape: Shape): { readonly dag: RelDag } => {
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

const fetchedUnder = (dag: RelDag, evidence: Evidence): Ran => {
	const query = queryOf(dag, [])
	const ran = succeeded(
		runPasses(query, [lateFetchPass], passContext({ catalog: ledgerCatalog, evidence }))
	)
	deliversAlikeOn(databases, [Account, Posting], [], query, ran.query)
	lowersConservatively(ran.query, emptyCodebook)
	return ran
}

const shapes: Gen<Shape> = (source) => ({
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
type LateFetchFeature =
	| `fetched on ${Evidence} evidence`
	| "held back: the order reads the payload"
	| "held back: no key of the payload's relation"
	| "held back: a lateral reader"

describe("late payload fetch", () => {
	it.effect(
		"selects the narrow key under the bound, then joins the payload back through the key",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "a take of one or two over a stage that carries Account's key or none, ordered by the key or reading the payload, read by the query, a join or a lateral join, in each evidence context",
						oracle: {
							kind: "specification",
							name: "R06 fetches late exactly over a key the stage carries, an order free of the payload and no lateral reader"
						},
						suite: "unit/lower/rewrite/late-fetch-proof",
						literal: Formatter.format,
						generator: shapes,
						coverage: requiredInSpace<LateFetchFeature>([
							"fetched on snapshot evidence",
							"fetched on transaction evidence",
							"held back: the order reads the payload",
							"held back: no key of the payload's relation",
							"held back: a lateral reader"
						]),
						caseHang,
						concurrency: 1
					},
					(shape, c) =>
						Effect.sync(() => {
							const ran = fetchedUnder(bounded(shape).dag, shape.evidence)
							const cert = Arr.findFirst(ran.certificates, (x) => x.rule === "R06.lateFetch")
							if (shape.order === "reading the payload") {
								c.note("held back: the order reads the payload")
							} else if (shape.stage === "carries no Account key") {
								c.note("held back: no key of the payload's relation")
							} else if (
								shape.reader === "a join reading the take laterally" ||
								shape.reader === "a join reading the stage laterally"
							) {
								c.note("held back: a lateral reader")
							} else {
								c.note(`fetched on ${shape.evidence} evidence`)
								const certified = Option.getOrThrowWith(
									cert,
									() => new Error("the late fetch's certificate")
								)
								assert.equal(certified.context, "immediate")
								assert.deepEqual(
									Arr.flatMap(certified.premises, (p) =>
										p.kind === "constraint" ? [p.constraint] : []
									),
									[accountKey]
								)
								for (const take of nodesOf(ran.query.dag, "Take")) {
									lacks(
										Arr.map(take.heading, (col) => col.name),
										"name"
									)
								}
								return
							}
							assertNone(cert)
						})
				)
			)
	)

	it.effect("refuses a correlated take, whose rows are selected per outer row", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "no correlated take is fetched late; the reference's delivery"
					},
					suite: "unit/lower/rewrite/late-fetch-correlated",
					draw: drawn(wideCaseGen),
					literal: Formatter.format,
					coverage: required<"fetched" | "a correlated take held back">(
						["fetched", "a correlated take held back"],
						{ cases: 200, sense: notesOnly }
					),
					kept: [],
					runs: 200,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(q, c) =>
					Effect.sync(() => {
						const input = caseQuery(q)
						const correlated = Arr.some(nodesOf(input.dag, "Take"), (t) => t.correlation.length > 0)
						for (const evidence of [
							"snapshot",
							"transaction"
						] as const satisfies ReadonlyArray<Evidence>) {
							const ran = succeeded(
								runPasses(
									input,
									[lateFetchPass],
									passContext({ catalog: genCatalog(q.schema), evidence })
								)
							)
							agrees(q, ran.query)
							succeeded(lowerConservatively(ran.query, schemaCodes(q.schema)))
							const fetched = Arr.contains(rulesOf(ran.certificates), "R06.lateFetch")
							if (correlated) {
								assert.equal(fetched, false)
								c.note("a correlated take held back")
							} else if (fetched) {
								c.note("fetched")
							}
						}
					})
			)
		)
	)
})
