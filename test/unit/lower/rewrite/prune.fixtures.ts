/** What the properties of prune.test.ts read: its spaces, models and helpers. */

import { Array as Arr } from "effect"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { nodesByLabel } from "#compiler/ir/dag.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { GeneratedRead } from "#compiler/ir/keys.ts"
import { conservativeMeta, type RelDag, type RelNode } from "#compiler/ir/rel.ts"
import { relationalRewrites } from "#compiler/lower/optimize/demand/phases.ts"
import { prunePass } from "#compiler/lower/optimize/prune/index.ts"
import { succeeded } from "#test/support/assert.ts"
import { heading } from "#test/support/unit/ir/fixture.ts"
import {
	type AggregateSpec,
	Edge,
	plainRegion,
	Q,
	type RelationSpec,
	T,
	uuidOf
} from "#test/support/unit/lower/conservative/fixtures.ts"
import {
	deliversAlikeOn,
	factSubsets,
	type HandFacts,
	ledgerCatalog,
	lowersConservatively,
	passContext,
	queryOf,
	type Ran,
	runPasses
} from "#test/support/unit/lower/rewrite/support.ts"

/** A uuid literal of the ledger fixture's n-th id (conservative/fixtures.ts uuidOf). */
const u = (n: number): TypedLiteral => ({ kind: "uuid", value: uuidOf(n) })

/** A bigint literal. */
const i8 = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })

/**
 * Every database of these postings: two of one account with one amount, which a fold over (account, amount) counts
 * once and one over (id, account, amount) twice.
 */
export const postings = factSubsets({
	Posting: [
		[u(1), u(10), i8(5)],
		[u(2), u(10), i8(5)],
		[u(3), u(11), i8(7)]
	]
})

/**
 * Runs demand pruning over the DAG, held to every database's delivery and to the conservative lowering, and the
 * relational rewrites composed, held to the delivery too; the pruning run.
 */
export const pruned = (
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
export const headingOf = (dag: RelDag, node: RelNode) => {
	const found = nodesByLabel(dag).get(node.id)
	return found === undefined ? undefined : Arr.map(found.heading, (c) => c.name)
}

/** One of the fold's three aggregates. */
type Aggregate = "total" | "n" | "top"

/** Each aggregate of the fold over postings: a sum, a count and a max. */
export const aggregates: Readonly<Record<Aggregate, AggregateSpec>> = {
	total: { name: "total", fn: "sum", op: "sum(bigint)", args: ["amount"], type: T.numeric },
	n: { name: "n", fn: "count", op: "count()", args: [], type: T.int8 },
	top: { name: "top", fn: "max", op: "max(bigint)", args: ["amount"], type: T.int8 }
}

/** The fold's aggregates, in the order the fold states them. */
export const aggregateNames: ReadonlyArray<Aggregate> = ["total", "n", "top"]

/** An integer literal. */
const i4 = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })

/** Every database of these edges: a path, and a loop the closure meets again. */
export const edges = factSubsets({
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
export type Stage = "projection" | "filter" | "region"

/** The stage of `stage`'s kind over the edges: a region of two of them, or a projection or a filter over one. */
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
 * matching the stage as its second source and delivering [src, dst := a]), a root region, or a region that is neither,
 * its dead variable in its heading or outside its named heading.
 */
export type Reader = "recursive step" | "root region" | "unpinned region" | "unpinned named region"

/** A stage read by a reader: the DAG, the region that reads the stage, and the stage. */
interface Read {
	readonly dag: RelDag
	readonly region: RelNode
	readonly stage: RelNode
}

/** The stage of `stageKind` read by `reader`. */
export const readBy = (stageKind: Stage, reader: Reader): Read => {
	const q = new Q()
	const stage = stageOver(q, stageKind)
	if (reader === "root region") {
		const region = q.regionWith([{ source: stage, bind: { a: "mid", b: "w" }, constants: {} }], {
			...plainRegion,
			heading: { kind: "named", names: ["mid"] }
		})
		return { dag: q.build(region).dag, region, stage }
	}
	if (reader === "unpinned region" || reader === "unpinned named region") {
		const region = q.regionWith([{ source: stage, bind: { a: "mid", b: "w" }, constants: {} }], {
			...plainRegion,
			heading: reader === "unpinned region" ? { kind: "bound" } : { kind: "named", names: ["mid"] }
		})
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

/** The columns each occurrence of `region` binds in `dag`, in order. */
export const bindingsOf = (dag: RelDag, region: RelNode): ReadonlyArray<ReadonlyArray<string>> => {
	const node = nodesByLabel(dag).get(region.id)
	return node?.kind === "MatchRegion"
		? Arr.map(node.occurrences, (o) => Arr.map(o.bindings, (b) => b.column))
		: []
}

/** A relation two of whose fields are generated: g from a, h from b and c. */
export const Generating: RelationSpec = {
	name: "Generating",
	heading: heading(
		["id", T.int4],
		["a", T.int4],
		["b", T.int4],
		["c", T.int4],
		["g", T.int4],
		["h", T.int4]
	),
	primaryKey: ["id"]
}

/** Generating's generations, each field with the fields its generation reads. */
export const generations: ReadonlyArray<GeneratedRead> = [
	{ field: "g", reads: ["a"] },
	{ field: "h", reads: ["b", "c"] }
]

/** The columns of Generating a query may read beside its key. */
export const generatingColumns = ["a", "b", "c", "g", "h"] as const
