import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, subarray } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { nodesByLabel } from "#compiler/ir/dag.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { conservativeMeta, type RelDag, type RelNode } from "#compiler/ir/rel.ts"
import { relationalRewrites } from "#compiler/lower/optimize/demand/phases.ts"
import { prunePass } from "#compiler/lower/optimize/prune/index.ts"
import { assert, contains, defined, lacks, succeeded } from "#test/support/assert.ts"
import { heading } from "#test/unit/ir/fixture.ts"
import {
	type AggregateSpec,
	Edge,
	Posting,
	plainRegion,
	Q,
	type RelationSpec,
	T,
	uuidOf
} from "#test/unit/lower/conservative/fixtures.ts"

import { caseHang } from "#test/support/limits.ts"
import {
	passContext,
	deliversAlikeOn,
	factSubsets,
	type HandFacts,
	ledgerCatalog,
	lowersConservatively,
	queryOf,
	type Ran,
	rulesOf,
	runPasses
} from "#test/unit/lower/rewrite/support.ts"

/**
 * Pruning: unused columns leave the nodes whose meaning allows it, "preserve the complete distinct
 * binding input to aggregates, including bound variables omitted from the answer"; a dead witness becomes an
 * existential; a union keeps its literal discriminant; a root keeps its heading; a node on
 * or read by a recursive step keeps its form, and its inputs keep every column that form reads.
 */

const u = (n: number): TypedLiteral => ({ kind: "uuid", value: uuidOf(n) })
const i8 = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })

/**
 * Every database of these postings: two of one account with one amount, which a fold over (account, amount) counts
 * once and one over (id, account, amount) twice.
 */
const postings = factSubsets({
	Posting: [
		[u(1), u(10), i8(5)],
		[u(2), u(10), i8(5)],
		[u(3), u(11), i8(7)]
	]
})

const pruned = (
	dag: RelDag,
	relations: ReadonlyArray<RelationSpec>,
	databases: ReadonlyArray<HandFacts>
): Ran => {
	const query = queryOf(dag, [])
	const ran = succeeded(
		runPasses(query, [prunePass], passContext({ catalog: ledgerCatalog, evidence: "snapshot" }))
	)
	deliversAlikeOn(databases, relations, [], query, ran.query)
	lowersConservatively(ran.query, emptyCodebook)
	/** The relational rewrites composed, pruning among them, deliver alike too. */
	const composed = succeeded(
		runPasses(
			query,
			[relationalRewrites],
			passContext({ catalog: ledgerCatalog, evidence: "snapshot" })
		)
	)
	deliversAlikeOn(databases, relations, [], query, composed.query)
	return ran
}

/** The heading of the node of `dag` labelled as `node` is, by name. */
const headingOf = (dag: RelDag, node: RelNode) => {
	const found = nodesByLabel(dag).get(node.id)
	return found === undefined ? undefined : Arr.map(found.heading, (c) => c.name)
}

type Aggregate = "total" | "n" | "top"

const aggregates: Readonly<Record<Aggregate, AggregateSpec>> = {
	total: { name: "total", fn: "sum", op: "sum(bigint)", args: ["amount"], type: T.numeric },
	n: { name: "n", fn: "count", op: "count()", args: [], type: T.int8 },
	top: { name: "top", fn: "max", op: "max(bigint)", args: ["amount"], type: T.int8 }
}

const aggregateNames: ReadonlyArray<Aggregate> = ["total", "n", "top"]

describe("demand pruning", () => {
	it.effect(
		"keeps a fold's whole bound tuple, the key no head reads included, and drops only undemanded aggregates",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/rewrite/prune-fold",
						literal: Formatter.format,
						/**
						 * A fold reads each posting once, by its key id, which its bound tuple holds though no head reads it
						 * (FoldInput); a fold over the projection (account, amount) is no plan (FoldOverProjection).
						 */
						generator: subarray(aggregateNames),
						limit: 8,
						coverage: requiredInSpace<"an aggregate dropped" | "every aggregate delivered">([
							"an aggregate dropped",
							"every aggregate delivered"
						]),
						caseHang
					},
					(delivered, c) =>
						Effect.sync(() => {
							const q = new Q()
							const region = q.region([
								{
									source: q.base(Posting, conservativeMeta),
									bind: { id: "id", account: "account", amount: "amount" },
									constants: {}
								}
							])
							const bound = ["id", "account", "amount"]
							const group = q.group(
								region,
								bound,
								["account"],
								Arr.map(aggregateNames, (a) => aggregates[a]),
								conservativeMeta
							)
							const ran = pruned(
								q.build(
									q.project(
										group,
										[["account", "account"], ...Arr.map(delivered, (a) => [a, a] as const)],
										conservativeMeta
									)
								).dag,
								[Posting],
								postings
							)
							c.note(
								delivered.length < aggregateNames.length
									? "an aggregate dropped"
									: "every aggregate delivered"
							)
							assert.deepEqual(headingOf(ran.query.dag, region), bound)
							assert.deepEqual(headingOf(ran.query.dag, group), ["account", ...delivered])
						})
				)
			)
	)
})

const i4 = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })

/** Every database of these edges: a path, and a loop the closure meets again. */
const edges = factSubsets({
	Edge: [
		[i4(1), i4(2)],
		[i4(2), i4(3)],
		[i4(3), i4(3)]
	]
})

/**
 * The stage a reader matches, binding its column a to a live variable and b to a dead one, and carrying a column c no
 * reader binds: a projection, a filter over a projection whose b and c copy the column the filter reads, or a region
 * joining two edges on b.
 */
type Stage = "projection" | "filter" | "region"

const stageOver = (q: Q, stage: Stage): RelNode => {
	if (stage === "region") {
		return q.region([
			{ source: q.base(Edge, conservativeMeta), bind: { src: "a", dst: "b" }, constants: {} },
			{ source: q.base(Edge, conservativeMeta), bind: { src: "b", dst: "c" }, constants: {} }
		])
	}
	if (stage === "projection") {
		return q.project(
			q.region([
				{ source: q.base(Edge, conservativeMeta), bind: { src: "a", dst: "b" }, constants: {} }
			]),
			[
				["a", "a"],
				["b", "b"],
				["c", "b"]
			],
			conservativeMeta
		)
	}
	const p = q.project(
		q.region([
			{ source: q.base(Edge, conservativeMeta), bind: { src: "a", dst: "d" }, constants: {} }
		]),
		[
			["a", "a"],
			["d", "d"],
			["b", "d"],
			["c", "d"]
		],
		conservativeMeta
	)
	return q.filter(p, q.op("int4gt", [q.col(p, "d"), q.int(0, T.int4)], T.bool))
}

/**
 * Who reads the stage: the closure of Edge's recursive step (Edge's closure from every source, its step region
 * matching the stage as its second source and delivering [src, dst := a]), a root region, or a region that is neither.
 */
type Reader = "recursive step" | "root region" | "unpinned region"

interface Read {
	readonly dag: RelDag
	readonly region: RelNode
	readonly stage: RelNode
}

const readBy = (stageKind: Stage, reader: Reader): Read => {
	const q = new Q()
	const stage = stageOver(q, stageKind)
	if (reader === "root region") {
		const region = q.regionWith([{ source: stage, bind: { a: "mid", b: "w" }, constants: {} }], {
			...plainRegion,
			heading: { kind: "named", names: ["mid"] }
		})
		return { dag: q.build(region).dag, region, stage }
	}
	if (reader === "unpinned region") {
		const region = q.region([{ source: stage, bind: { a: "mid", b: "w" }, constants: {} }])
		return {
			dag: q.build(q.project(region, [["mid", "mid"]], conservativeMeta)).dag,
			region,
			stage
		}
	}
	const pairHeading = heading(["src", T.int4], ["dst", T.int4])
	const seed = q.regionWith(
		[{ source: q.base(Edge, conservativeMeta), bind: { src: "src", dst: "dst" }, constants: {} }],
		{ ...plainRegion, heading: { kind: "named", names: ["src", "dst"] } }
	)
	const rec = q.b.reserve()
	const self = q.node({
		kind: "SelfRef",
		recursive: rec,
		heading: pairHeading,
		loc: undefined,
		meta: conservativeMeta
	})
	const region = q.region([
		{ source: self, bind: { src: "src", dst: "x" }, constants: {} },
		{ source: stage, bind: { a: "x", b: "w" }, constants: {} }
	])
	const step = q.project(
		region,
		[
			["src", "src"],
			["dst", "x"]
		],
		conservativeMeta
	)
	const recursive = q.b.define(rec, {
		kind: "Recursive",
		name: "reach",
		base: seed,
		step,
		self,
		termination: { kind: "finiteCarrier", stateEstimate: 100n, premises: [] },
		origin: [],
		heading: pairHeading,
		loc: undefined,
		meta: conservativeMeta
	})
	return {
		dag: q.build(q.project(recursive, [["dst", "dst"]], conservativeMeta)).dag,
		region,
		stage
	}
}

const bindingsOf = (dag: RelDag, region: RelNode): ReadonlyArray<ReadonlyArray<string>> => {
	const node = nodesByLabel(dag).get(region.id)
	return node?.kind === "MatchRegion"
		? Arr.map(node.occurrences, (o) => Arr.map(o.bindings, (b) => b.column))
		: []
}

describe("a pinned node keeps its form, and its inputs every column that form reads", () => {
	it.effect(
		"a stage read by a recursive step or a root region keeps the column of a dead binding",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/rewrite/prune-pinned",
						literal: Formatter.format,
						generator: (source) =>
							[
								source.draw(element<Stage>(["projection", "filter", "region"])),
								source.draw(element<Reader>(["recursive step", "root region", "unpinned region"]))
							] as const,
						limit: 9,
						coverage: requiredInSpace<`${Reader} over a ${Stage}`>([
							"recursive step over a projection",
							"recursive step over a filter",
							"recursive step over a region",
							"root region over a projection",
							"root region over a filter",
							"root region over a region",
							"unpinned region over a projection",
							"unpinned region over a filter",
							"unpinned region over a region"
						]),
						caseHang
					},
					([stageKind, reader], c) =>
						Effect.sync(() => {
							c.note(`${reader} over a ${stageKind}`)
							const { dag, region, stage } = readBy(stageKind, reader)
							const before = bindingsOf(dag, region)
							const ran = pruned(dag, [Edge], edges)
							const after = bindingsOf(ran.query.dag, region)
							const stageHeading = defined(headingOf(ran.query.dag, stage), "the stage")
							if (reader === "recursive step") {
								assert.deepEqual(after, before)
								assert.deepEqual(stageHeading, defined(headingOf(dag, stage), "the stage as built"))
								return
							}
							contains(rulesOf(ran.certificates), "prune.heading")
							lacks(stageHeading, "c")
							if (reader === "root region") {
								assert.deepEqual(after, before)
								for (const column of before.flat()) {
									contains(stageHeading, column)
								}
							} else {
								assert.deepEqual(
									after,
									Arr.map(before, (columns) => Arr.filter(columns, (column) => column !== "b"))
								)
							}
						})
				)
			)
	)
})

describe("a dead binding outside a named heading", () => {
	it.effect(
		"prunes a region's dead variable outside its named heading, the measure falling",
		(ctx) => {
			type Passes = "prune" | "the relational rewrites"
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/rewrite/prune-outside-heading",
						literal: Formatter.format,
						generator: element<Passes>(["prune", "the relational rewrites"]),
						limit: 2,
						coverage: requiredInSpace<Passes>(["prune", "the relational rewrites"]),
						caseHang
					},
					(passes, c) =>
						Effect.sync(() => {
							c.note(passes)
							const q = new Q()
							const region = q.regionWith(
								[
									{
										source: q.base(Posting, conservativeMeta),
										bind: { id: "id", amount: "amount" },
										constants: {}
									}
								],
								{ ...plainRegion, heading: { kind: "named", names: ["id"] } }
							)
							const query = queryOf(
								q.build(q.project(region, [["id", "id"]], conservativeMeta)).dag,
								[]
							)
							const ran = succeeded(
								runPasses(
									query,
									passes === "prune" ? [prunePass] : [relationalRewrites],
									passContext({ catalog: ledgerCatalog, evidence: "snapshot" })
								)
							)
							contains(rulesOf(ran.certificates), "prune.heading")
							assert.deepEqual(bindingsOf(ran.query.dag, region), [["id"]])
							deliversAlikeOn(postings, [Posting], [], query, ran.query)
							lowersConservatively(ran.query, emptyCodebook)
						})
				)
			)
		}
	)
})
