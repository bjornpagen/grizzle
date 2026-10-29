import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import { heading } from "#test/unit/ir/fixture.ts"
import {
	Account,
	Edge,
	keyed,
	Posting,
	plainRegion,
	Q,
	T,
	Task,
	uuidOf
} from "#test/unit/lower/conservative/fixtures.ts"

/**
 * The conservative lowering's test queries over the ledger fixture, with the facts the pg tests load and the rows the
 * language's semantics give for them. Each query states the shape a checked rule produces; the expected rows are
 * worked out by hand from the facts below, so the PostgreSQL run checks the lowering against the meaning, not against
 * itself.
 */

export const A = uuidOf(0x1001)
export const B = uuidOf(0x1002)
export const C = uuidOf(0x1003)
const p = (n: number) => uuidOf(0x2000 + n)
const t = (n: number) => uuidOf(0x3000 + n)

/** Facts, as SQL literals per column of each relation, in heading order. */
export const facts: Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>> = {
	Posting: [
		[p(1), A, "100"],
		[p(2), A, "100"],
		[p(3), B, "50"],
		[p(4), B, "70"]
	],
	Account: [
		[A, "alpha"],
		[B, "beta"],
		[C, "gamma"]
	],
	Task: [
		[t(1), A, "Automatic", "10"],
		[t(2), A, "Manual", "20"],
		[t(3), B, "Automatic", "30"],
		[t(4), B, "Automatic", "40"],
		[t(5), A, "Automatic", "50"]
	],
	Edge: [
		["1", "2"],
		["2", "3"],
		["1", "3"],
		["3", "1"],
		["4", "5"]
	],
	Reading: [
		["1", "NaN", "1.0", "1.50", "true"],
		["2", "-0", "1.00", "2.00", "false"],
		["3", "0", "2.5", "1.50", "true"],
		["4", "NaN", "2.50", "0.10", "true"]
	]
}

/** A hand-built query over the ledger fixtures, by name. */
export interface LoweringCase {
	readonly name: string
	readonly query: LogicalQuery
}

const sumInt8 = { fn: "sum" as const, op: "int8_sum", type: T.numeric } as const

/** byFact binds id, account and amount; byAmount only account and amount. */
export const byFact = (): LoweringCase => {
	const q = new Q()
	const posting = q.base(Posting, conservativeMeta)
	const m = q.region([
		{ source: posting, bind: { id: "id", account: "account", amount: "amount" }, constants: {} }
	])
	const g = q.group(
		m,
		["id", "account", "amount"],
		["account"],
		[{ name: "total", args: ["amount"], ...sumInt8 }],
		conservativeMeta
	)
	return { name: "byFact", query: q.build(g) }
}

export const byAmount = (): LoweringCase => {
	const q = new Q()
	const posting = q.base(Posting, conservativeMeta)
	const m = q.region([
		{ source: posting, bind: { account: "account", amount: "amount" }, constants: {} }
	])
	const g = q.group(
		m,
		["account", "amount"],
		["account"],
		[{ name: "total", args: ["amount"], ...sumInt8 }],
		conservativeMeta
	)
	return { name: "byAmount", query: q.build(g) }
}

/** An aggregate-only count over every posting, and over an empty filtered input (zero rows). */
export const countAll = (): LoweringCase => {
	const q = new Q()
	const m = q.region([
		{ source: q.base(Posting, conservativeMeta), bind: { id: "id" }, constants: {} }
	])
	const g = q.group(
		m,
		["id"],
		[],
		[{ name: "n", fn: "count", op: "count", args: [], type: T.int8 }],
		conservativeMeta
	)
	return { name: "countAll", query: q.build(g) }
}

/** Aggregate boundaries remain exact: the accounts that have a posting, and those that have none (r.not). */
export const withPostings = (anti: boolean): LoweringCase => {
	const q = new Q()
	const accounts = q.project(
		q.region([{ source: q.base(Account, conservativeMeta), bind: { id: "id" }, constants: {} }]),
		[["id", "id"]],
		conservativeMeta
	)
	const postings = q.project(
		q.region([
			{ source: q.base(Posting, conservativeMeta), bind: { account: "account" }, constants: {} }
		]),
		[["account", "account"]],
		conservativeMeta
	)
	const s = anti
		? q.anti(accounts, postings, [["id", "account"]])
		: q.semi(accounts, postings, [["id", "account"]])
	return {
		name: anti ? "withoutPostings" : "withPostings",
		query: q.build(s)
	}
}

/** A union of overlapping arms is one set. */
export const unionArms = (): LoweringCase => {
	const q = new Q()
	const alpha = q.region([
		{
			source: q.base(Account, conservativeMeta),
			bind: { id: "id" },
			constants: { name: q.lit({ kind: "text", value: "alpha" }, T.text) }
		}
	])
	const hundred = q.region([
		{
			source: q.base(Posting, conservativeMeta),
			bind: { account: "id" },
			constants: { amount: q.int(100, T.int8) }
		}
	])
	const u = q.union(
		[
			q.project(alpha, [["id", "id"]], conservativeMeta),
			q.project(hundred, [["id", "id"]], conservativeMeta)
		],
		[]
	)
	return { name: "unionArms", query: q.build(u) }
}

/** Arms of different headings, told apart by the literal discriminant `kind`, delivered per group. */
const kindLit = (q: Q, handle: "Automatic" | "Manual"): ScalarExpr =>
	q.lit({ kind: "enum", handle }, T.kind)
export const heterogeneous = (bounded: boolean): LoweringCase => heterogeneousOf(bounded, false)

const heterogeneousOf = (bounded: boolean, reordered: boolean): LoweringCase => {
	const q = new Q()
	const auto = q.region([
		{
			source: q.base(Task, conservativeMeta),
			bind: { account: "account", amount: "amount" },
			constants: { kind: kindLit(q, "Automatic") }
		}
	])
	const manual = q.region([
		{
			source: q.base(Task, conservativeMeta),
			bind: { account: "account" },
			constants: { kind: kindLit(q, "Manual") }
		}
	])
	const armA = q.project(
		auto,
		[
			["kind", [kindLit(q, "Automatic"), T.kind]],
			["account", "account"],
			["amount", "amount"]
		],
		conservativeMeta
	)
	const armM = q.project(
		manual,
		[
			["kind", [kindLit(q, "Manual"), T.kind]],
			["account", "account"]
		],
		conservativeMeta
	)
	const u = q.union([armA, armM], ["kind"])
	if (!bounded) {
		return {
			name: "heterogeneous",
			query: q.build(u)
		}
	}
	const top = q.take(
		u,
		{
			keys: [
				{ column: "account", dir: "desc" },
				{ column: "kind", dir: "asc" }
			]
		},
		{ kind: "literal", k: 1n },
		[],
		conservativeMeta
	)
	const root = reordered
		? q.ordered(top, {
				keys: [
					{ column: "account", dir: "asc" },
					{ column: "kind", dir: "asc" }
				]
			})
		: top
	return {
		name: reordered ? "heterogeneousTakeReordered" : "heterogeneousTake",
		query: q.build(root)
	}
}

/** The top two tasks by amount. */
export const topTasks = (): LoweringCase => {
	const q = new Q()
	const m = q.region([
		{ source: q.base(Task, conservativeMeta), bind: { id: "id", amount: "amount" }, constants: {} }
	])
	const top = q.take(
		m,
		{
			keys: [
				{ column: "amount", dir: "desc" },
				{ column: "id", dir: "asc" }
			]
		},
		q.bound("k"),
		[],
		conservativeMeta
	)
	return {
		name: "topTasks",
		query: q.build(
			q.ordered(top, {
				keys: [
					{ column: "amount", dir: "desc" },
					{ column: "id", dir: "asc" }
				]
			})
		)
	}
}

/**
 * A take per account through a correlated bound: per account, its largest task, read by a
 * region as a LATERAL source correlated with the region's account variable.
 */
export const topTaskPerAccount = (): LoweringCase => {
	const q = new Q()
	const tasks = q.region([
		{
			source: q.base(Task, conservativeMeta),
			bind: { id: "id", account: "account", amount: "amount" },
			constants: {}
		}
	])
	const outer = q.b.reserve()
	const accountRef = q.b.expr({
		kind: "column",
		column: { node: outer, name: "acct" },
		args: [],
		type: T.uuid,
		nonNull: "storage"
	})
	const top = q.take(
		tasks,
		{
			keys: [
				{ column: "amount", dir: "desc" },
				{ column: "id", dir: "asc" }
			]
		},
		{ kind: "literal", k: 1n },
		[{ column: "account", expr: accountRef }],
		keyed(["id"], "many")
	)
	const region = q.regionWith(
		[
			{ source: q.base(Account, conservativeMeta), bind: { id: "acct" }, constants: {} },
			{ source: top, bind: { id: "task", account: "acct", amount: "amount" }, constants: {} }
		],
		{ ...plainRegion, id: { kind: "reserved", id: outer } }
	)
	return {
		name: "topTaskPerAccount",
		query: q.build(region)
	}
}

/**
 * Each account with its total, attached as an Option, and its tasks as an ordered array.
 *
 * The spine is read from the root: the tasks attachment first, then the total.
 */
export const accountTotals = (): LoweringCase => {
	const q = new Q()
	const accounts = q.project(
		q.region([
			{ source: q.base(Account, conservativeMeta), bind: { id: "id", name: "name" }, constants: {} }
		]),
		[
			["id", "id"],
			["name", "name"]
		],
		conservativeMeta
	)
	const postings = q.region([
		{
			source: q.base(Posting, conservativeMeta),
			bind: { id: "pid", account: "account", amount: "amount" },
			constants: {}
		}
	])
	const totals = q.group(
		postings,
		["pid", "account", "amount"],
		["account"],
		[{ name: "total", args: ["amount"], ...sumInt8 }],
		keyed(["account"], "many")
	)
	const tasks = q.project(
		q.region([
			{
				source: q.base(Task, conservativeMeta),
				bind: { id: "id", account: "account", amount: "amount" },
				constants: {}
			}
		]),
		[
			["account", "account"],
			["amount", "amount"]
		],
		conservativeMeta
	)
	const withTotal = q.attach(accounts, totals, "total", [["id", "account"]], "option", undefined)
	const withTasks = q.attach(withTotal, tasks, "tasks", [["id", "account"]], "array", {
		keys: [{ column: "amount", dir: "desc" }]
	})
	return {
		name: "accountTotals",
		query: q.build(withTasks)
	}
}

/** The transitive closure of Edge as a recursive relation, from a seed parameter. */
const reachNode = (q: Q): RelNode => {
	const pair = heading(["src", T.int4], ["dst", T.int4])
	const seedRegion = q.regionWith(
		[{ source: q.base(Edge, conservativeMeta), bind: { src: "src", dst: "dst" }, constants: {} }],
		{ ...plainRegion, heading: { kind: "named", names: ["src", "dst"] } }
	)
	const seed = q.filter(
		seedRegion,
		q.op("int4eq", [q.col(seedRegion, "src"), q.param("start", T.int4, "compare")], T.bool, "total")
	)
	const rec = q.b.reserve()
	const self = q.node({
		kind: "SelfRef",
		recursive: rec,
		heading: pair,
		loc: undefined,
		meta: conservativeMeta
	})
	const step = q.project(
		q.region([
			{ source: self, bind: { src: "src", dst: "mid" }, constants: {} },
			{ source: q.base(Edge, conservativeMeta), bind: { src: "mid", dst: "dst" }, constants: {} }
		]),
		[
			["src", "src"],
			["dst", "dst"]
		],
		conservativeMeta
	)
	return q.b.define(rec, {
		kind: "Recursive",
		name: "reach",
		base: seed,
		step,
		self,
		termination: { kind: "finiteCarrier", stateEstimate: 100n, premises: [] },
		origin: ["src"],
		heading: pair,
		loc: undefined,
		meta: conservativeMeta
	})
}

export const reach = (): LoweringCase => {
	const q = new Q()
	return {
		name: "reach",
		query: q.build(reachNode(q))
	}
}

/** A closed relation with payloads, matched by its handle. */
export const closedLabels = (): LoweringCase => {
	const q = new Q()
	const labels = q.closed("KindLabel", heading(["id", T.kind], ["label", T.text]), [
		[
			{ kind: "enum", handle: "Automatic" },
			{ kind: "text", value: "auto" }
		],
		[
			{ kind: "enum", handle: "Manual" },
			{ kind: "text", value: "by hand" }
		]
	])
	const m = q.region([
		{
			source: q.base(Task, conservativeMeta),
			bind: { account: "account", kind: "kind" },
			constants: {}
		},
		{ source: labels, bind: { id: "kind", label: "label" }, constants: {} }
	])
	return {
		name: "closedLabels",
		query: q.build(
			q.project(
				m,
				[
					["account", "account"],
					["label", "label"]
				],
				conservativeMeta
			)
		)
	}
}

/** INTERSECT and EXCEPT of two account sets. */
export const accountSets = (kind: "Intersect" | "Difference"): LoweringCase => {
	const q = new Q()
	const named = q.project(
		q.region([{ source: q.base(Account, conservativeMeta), bind: { id: "id" }, constants: {} }]),
		[["id", "id"]],
		conservativeMeta
	)
	const tasked = q.project(
		q.region([
			{
				source: q.base(Task, conservativeMeta),
				bind: { account: "id" },
				constants: { kind: kindLit(q, "Manual") }
			}
		]),
		[["id", "id"]],
		conservativeMeta
	)
	return {
		name: kind,
		query: q.build(q.setOp(kind, named, tasked))
	}
}

/** avg over the distinct (id, account, amount) bindings: A averages 100 and 100, B 50 and 70. */
export const averageAmount = (): LoweringCase => {
	const q = new Q()
	const m = q.region([
		{
			source: q.base(Posting, conservativeMeta),
			bind: { id: "id", account: "account", amount: "amount" },
			constants: {}
		}
	])
	const g = q.group(
		m,
		["id", "account", "amount"],
		["account"],
		[{ name: "mean", fn: "avg", op: "int8_avg", args: ["amount"], type: T.numeric }],
		conservativeMeta
	)
	return {
		name: "averageAmount",
		query: q.build(g)
	}
}
